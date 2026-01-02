use anyhow::{anyhow, Result};
use reqwest::blocking::Client;
use reqwest::{Client as AsyncClient, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::io::BufRead;
use std::path::PathBuf;
use std::time::Duration;

const DEFAULT_OLLAMA_BASE: &str = "http://127.0.0.1:11434/api";
const DEFAULT_OLLAMA_TIMEOUT_SECS: u64 = 300;
const MAX_ERROR_BODY_BYTES: usize = 4096;
const DEFAULT_OLLAMA_CLOUD_BASE: &str = "https://ollama.com";
const DEFAULT_OLLAMA_CLOUD_TIMEOUT_SECS: u64 = 10;
const OLLAMA_CLOUD_BASE_ENV: &str = "OLLAMA_CLOUD_BASE_URL";
const OLLAMA_CLOUD_MODELS_URL_ENV: &str = "OLLAMA_CLOUD_MODELS_URL";
const OLLAMA_CLOUD_TOKEN_ENV_VARS: [&str; 4] = [
  "OLLAMA_CLOUD_TOKEN",
  "OLLAMA_AUTH_TOKEN",
  "OLLAMA_TOKEN",
  "OLLAMA_API_KEY",
];

#[derive(Debug)]
pub struct OllamaHttpError {
  pub status: StatusCode,
  pub body: String,
}

impl fmt::Display for OllamaHttpError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "Ollama error {}: {}", self.status, self.body)
  }
}

impl std::error::Error for OllamaHttpError {}

fn truncate_body(body: &str) -> String {
  if body.len() <= MAX_ERROR_BODY_BYTES {
    return body.to_string();
  }
  let mut end = 0usize;
  for (idx, ch) in body.char_indices() {
    let next = idx + ch.len_utf8();
    if next > MAX_ERROR_BODY_BYTES {
      break;
    }
    end = next;
  }
  format!("{}...[truncated]", &body[..end])
}

#[derive(Clone)]
pub struct Ollama {
  http: Client,
  base: String,
}

impl Ollama {
  pub fn new() -> Self {
    let http = Client::builder()
      .timeout(ollama_timeout())
      .no_proxy()
      .build()
      .unwrap_or_else(|_| Client::new());
    Self {
      http,
      base: ollama_base_url(),
    }
  }

  pub fn embed(&self, model: &str, input: impl Into<EmbedInput>) -> Result<Vec<Vec<f32>>> {
    let req = EmbedRequest {
      model: model.to_string(),
      input: input.into(),
      truncate: Some(true),
    };

    // /api/embed: input może być string albo array stringów 
    let resp = self
      .http
      .post(format!("{}/embed", self.base))
      .json(&req)
      .send()?;
    let status = resp.status();
    if !status.is_success() {
      let body = truncate_body(&resp.text().unwrap_or_default());
      return Err(anyhow!(OllamaHttpError { status, body }));
    }
    let resp: EmbedResponse = resp.json()?;

    Ok(resp.embeddings)
  }

  pub fn chat(&self, model: &str, messages: Vec<ChatMessage>) -> Result<String> {
    let req = ChatRequest {
      model: model.to_string(),
      messages,
      stream: Some(false), // streaming off = prościej do obsługi 
    };

    // /api/chat 
    let resp = self
      .http
      .post(format!("{}/chat", self.base))
      .json(&req)
      .send()?;
    let status = resp.status();
    if !status.is_success() {
      let body = truncate_body(&resp.text().unwrap_or_default());
      return Err(anyhow!(OllamaHttpError { status, body }));
    }
    let resp: ChatResponse = resp.json()?;

    resp
      .message
      .map(|m| m.content)
      .ok_or_else(|| anyhow!("No message content in Ollama response"))
  }

  pub fn chat_stream<F>(&self, model: &str, messages: Vec<ChatMessage>, mut on_delta: F) -> Result<String>
  where
    F: FnMut(&str),
  {
    let req = ChatRequest {
      model: model.to_string(),
      messages,
      stream: Some(true),
    };

    let resp = self
      .http
      .post(format!("{}/chat", self.base))
      .json(&req)
      .send()?;
    let status = resp.status();
    if !status.is_success() {
      let body = truncate_body(&resp.text().unwrap_or_default());
      return Err(anyhow!(OllamaHttpError { status, body }));
    }

    let mut reader = std::io::BufReader::new(resp);
    let mut line = String::new();
    let mut answer = String::new();

    loop {
      line.clear();
      let read = reader.read_line(&mut line)?;
      if read == 0 {
        break;
      }
      let trimmed = line.trim();
      if trimmed.is_empty() {
        continue;
      }
      let payload = trimmed.strip_prefix("data: ").unwrap_or(trimmed);
      if payload == "[DONE]" {
        break;
      }

      let chunk: ChatStreamResponse = serde_json::from_str(payload)?;
      if let Some(err) = chunk.error {
        return Err(anyhow!("Ollama stream error: {err}"));
      }
      if let Some(msg) = chunk.message {
        if !msg.content.is_empty() {
          on_delta(&msg.content);
          answer.push_str(&msg.content);
        }
      }
      if chunk.done.unwrap_or(false) {
        break;
      }
    }

    Ok(answer)
  }

  pub fn list_models(&self) -> Result<Vec<String>> {
    let resp = self
      .http
      .get(format!("{}/tags", self.base))
      .send()?;
    let status = resp.status();
    if !status.is_success() {
      let body = truncate_body(&resp.text().unwrap_or_default());
      return Err(anyhow!(OllamaHttpError { status, body }));
    }
    let resp: TagsResponse = resp.json()?;

    Ok(resp.models.into_iter().map(|m| m.name).collect())
  }

  pub fn runtime_status(&self) -> Result<OllamaRuntimeStatus> {
    let resp = self
      .http
      .get(format!("{}/ps", self.base))
      .send()?;
    let status = resp.status();
    if !status.is_success() {
      let body = truncate_body(&resp.text().unwrap_or_default());
      return Err(anyhow!(OllamaHttpError { status, body }));
    }
    let raw: Value = resp.json()?;
    let mut models = Vec::new();
    if let Some(items) = raw.get("models").and_then(|v| v.as_array()) {
      for item in items {
        let name = item
          .get("name")
          .and_then(|v| v.as_str())
          .unwrap_or("unknown")
          .to_string();
        let size_vram = extract_u64(item, "size_vram").or_else(|| extract_u64(item, "sizeVram"));
        let size_system = extract_u64(item, "size_system").or_else(|| extract_u64(item, "sizeSystem"));
        let processor = infer_processor(item, size_vram, size_system);
        models.push(OllamaRuntimeModel {
          name,
          processor,
          size_vram,
          size_system,
        });
      }
    }

    let status = if models.is_empty() {
      "idle".to_string()
    } else if models.iter().any(|m| is_gpu(&m.processor)) {
      "gpu".to_string()
    } else if models.iter().any(|m| is_cpu(&m.processor)) {
      "cpu".to_string()
    } else {
      "unknown".to_string()
    };

    Ok(OllamaRuntimeStatus { status, models })
  }
}

#[derive(Serialize)]
pub struct OllamaRuntimeModel {
  pub name: String,
  pub processor: String,
  pub size_vram: Option<u64>,
  pub size_system: Option<u64>,
}

#[derive(Serialize)]
pub struct OllamaRuntimeStatus {
  pub status: String,
  pub models: Vec<OllamaRuntimeModel>,
}

#[derive(Deserialize)]
struct TagsResponse {
  models: Vec<ModelInfo>,
}

#[derive(Deserialize)]
struct ModelInfo {
  name: String,
}

pub async fn list_models_with_timeout(timeout: Duration) -> Result<Vec<String>> {
  let client = AsyncClient::builder().timeout(timeout).no_proxy().build()?;
  let base = ollama_base_url();
  let resp = client
    .get(format!("{base}/tags"))
    .send()
    .await?;
  let status = resp.status();
  if !status.is_success() {
    let body = truncate_body(&resp.text().await.unwrap_or_default());
    return Err(anyhow!(OllamaHttpError { status, body }));
  }
  let data: TagsResponse = resp.json().await?;
  Ok(data.models.into_iter().map(|m| m.name).collect())
}

pub fn list_cloud_models() -> Result<Vec<String>> {
  let Some(token) = load_cloud_token() else {
    return Ok(Vec::new());
  };
  let client = Client::builder().timeout(cloud_timeout()).build()?;
  for url in cloud_models_urls() {
    let resp = match client.get(&url).bearer_auth(&token).send() {
      Ok(resp) => resp,
      Err(_) => continue,
    };
    let status = resp.status();
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
      return Ok(Vec::new());
    }
    let body = resp.text().unwrap_or_default();
    if !status.is_success() {
      continue;
    }
    if let Some(models) = parse_cloud_models(&body) {
      return Ok(models);
    }
  }
  Ok(Vec::new())
}

fn ollama_base_url() -> String {
  let from_env = std::env::var("OLLAMA_BASE_URL")
    .or_else(|_| std::env::var("OLLAMA_HOST"))
    .ok();
  match from_env.as_deref() {
    Some(raw) => normalize_ollama_base(raw),
    None => DEFAULT_OLLAMA_BASE.to_string(),
  }
}

fn normalize_ollama_base(raw: &str) -> String {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return DEFAULT_OLLAMA_BASE.to_string();
  }
  let mut base = if trimmed.contains("://") {
    trimmed.to_string()
  } else {
    format!("http://{trimmed}")
  };
  base = base.trim_end_matches('/').to_string();
  if base.ends_with("/api") {
    base
  } else {
    format!("{base}/api")
  }
}

fn ollama_timeout() -> Duration {
  let seconds = std::env::var("OLLAMA_TIMEOUT_SECS")
    .ok()
    .and_then(|v| v.parse::<u64>().ok())
    .filter(|v| *v > 0)
    .unwrap_or(DEFAULT_OLLAMA_TIMEOUT_SECS);
  Duration::from_secs(seconds)
}

fn cloud_timeout() -> Duration {
  let seconds = std::env::var("OLLAMA_CLOUD_TIMEOUT_SECS")
    .ok()
    .and_then(|v| v.parse::<u64>().ok())
    .filter(|v| *v > 0)
    .unwrap_or(DEFAULT_OLLAMA_CLOUD_TIMEOUT_SECS);
  Duration::from_secs(seconds)
}

fn cloud_models_urls() -> Vec<String> {
  if let Ok(raw) = std::env::var(OLLAMA_CLOUD_MODELS_URL_ENV) {
    let trimmed = raw.trim();
    if !trimmed.is_empty() {
      return vec![trimmed.to_string()];
    }
  }
  let base = std::env::var(OLLAMA_CLOUD_BASE_ENV).unwrap_or_else(|_| DEFAULT_OLLAMA_CLOUD_BASE.to_string());
  let normalized = normalize_cloud_base(&base);
  let mut bases = vec![normalized.clone()];
  if !normalized.ends_with("/api") {
    bases.push(format!("{normalized}/api"));
  }
  let mut urls = Vec::new();
  for base in bases {
    urls.push(format!("{base}/tags"));
    urls.push(format!("{base}/models"));
    urls.push(format!("{base}/me/models"));
  }
  urls
}

fn normalize_cloud_base(raw: &str) -> String {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return DEFAULT_OLLAMA_CLOUD_BASE.to_string();
  }
  let base = if trimmed.contains("://") {
    trimmed.to_string()
  } else {
    format!("https://{trimmed}")
  };
  base.trim_end_matches('/').to_string()
}

fn load_cloud_token() -> Option<String> {
  for key in OLLAMA_CLOUD_TOKEN_ENV_VARS {
    if let Ok(raw) = std::env::var(key) {
      let trimmed = raw.trim();
      if !trimmed.is_empty() {
        return Some(normalize_token(trimmed));
      }
    }
  }
  let home = home_dir()?;
  let base = home.join(".ollama");
  let candidates = [
    base.join("credentials.json"),
    base.join("config.json"),
    base.join("config"),
    base.join("credentials"),
    base.join("auth.json"),
    base.join("token"),
  ];
  for path in candidates {
    if let Ok(raw) = std::fs::read_to_string(&path) {
      if let Some(token) = parse_token(&raw) {
        return Some(token);
      }
    }
  }
  None
}

fn home_dir() -> Option<PathBuf> {
  std::env::var("HOME")
    .or_else(|_| std::env::var("USERPROFILE"))
    .ok()
    .map(PathBuf::from)
}

fn parse_token(raw: &str) -> Option<String> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return None;
  }
  if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
    if let Some(token) = extract_token_from_value(&value) {
      return Some(normalize_token(&token));
    }
  }
  let prefixes = [
    "token=",
    "token:",
    "access_token=",
    "access_token:",
    "auth_token=",
    "auth_token:",
    "api_key=",
    "api_key:",
  ];
  for line in trimmed.lines() {
    let line = line.trim();
    for prefix in prefixes {
      if let Some(rest) = line.strip_prefix(prefix) {
        let value = rest.trim();
        if !value.is_empty() {
          return Some(normalize_token(value));
        }
      }
    }
  }
  if !trimmed.chars().any(|c| c.is_whitespace()) && trimmed.len() > 8 {
    return Some(normalize_token(trimmed));
  }
  None
}

fn normalize_token(raw: &str) -> String {
  let trimmed = raw.trim();
  trimmed
    .strip_prefix("Bearer ")
    .or_else(|| trimmed.strip_prefix("bearer "))
    .unwrap_or(trimmed)
    .to_string()
}

fn extract_token_from_value(value: &Value) -> Option<String> {
  match value {
    Value::Object(map) => extract_token_from_map(map),
    Value::Array(items) => {
      for item in items {
        if let Some(token) = extract_token_from_value(item) {
          return Some(token);
        }
      }
      None
    }
    _ => None,
  }
}

fn extract_token_from_map(map: &serde_json::Map<String, Value>) -> Option<String> {
  let keys = [
    "token",
    "access_token",
    "accessToken",
    "id_token",
    "idToken",
    "auth_token",
    "authToken",
    "api_key",
    "apiKey",
  ];
  for key in keys {
    if let Some(Value::String(token)) = map.get(key) {
      let trimmed = token.trim();
      if !trimmed.is_empty() {
        return Some(normalize_token(trimmed));
      }
    }
  }
  for value in map.values() {
    if let Some(token) = extract_token_from_value(value) {
      return Some(token);
    }
  }
  None
}

fn parse_cloud_models(body: &str) -> Option<Vec<String>> {
  let value: Value = serde_json::from_str(body).ok()?;
  if let Some(models) = value.get("models").and_then(|v| v.as_array()) {
    let names = extract_model_names(models);
    return if names.is_empty() { None } else { Some(names) };
  }
  if let Some(models) = value.get("data").and_then(|v| v.as_array()) {
    let names = extract_model_names(models);
    return if names.is_empty() { None } else { Some(names) };
  }
  if let Some(models) = value.as_array() {
    let names = extract_model_names(models);
    return if names.is_empty() { None } else { Some(names) };
  }
  None
}

fn extract_model_names(items: &[Value]) -> Vec<String> {
  let mut models = Vec::new();
  for item in items {
    if let Some(name) = item.as_str() {
      let trimmed = name.trim();
      if !trimmed.is_empty() {
        models.push(trimmed.to_string());
      }
      continue;
    }
    let Some(obj) = item.as_object() else { continue };
    for key in ["name", "model", "id", "slug"] {
      if let Some(Value::String(name)) = obj.get(key) {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
          models.push(trimmed.to_string());
        }
        break;
      }
    }
  }
  models
}

fn extract_u64(value: &Value, key: &str) -> Option<u64> {
  value.get(key).and_then(|v| v.as_u64())
}

fn infer_processor(value: &Value, size_vram: Option<u64>, size_system: Option<u64>) -> String {
  if let Some(processor) = value.get("processor").and_then(|v| v.as_str()) {
    return normalize_processor(processor);
  }
  let num_gpu = extract_u64(value, "num_gpu").or_else(|| extract_u64(value, "numGpu")).unwrap_or(0);
  if num_gpu > 0 || size_vram.unwrap_or(0) > 0 {
    return "GPU".to_string();
  }
  if size_system.unwrap_or(0) > 0 {
    return "CPU".to_string();
  }
  "unknown".to_string()
}

fn normalize_processor(raw: &str) -> String {
  let lower = raw.trim().to_lowercase();
  if lower.contains("gpu") {
    "GPU".to_string()
  } else if lower.contains("cpu") {
    "CPU".to_string()
  } else {
    raw.trim().to_string()
  }
}

fn is_gpu(processor: &str) -> bool {
  processor.eq_ignore_ascii_case("gpu") || processor.to_lowercase().contains("gpu")
}

fn is_cpu(processor: &str) -> bool {
  processor.eq_ignore_ascii_case("cpu") || processor.to_lowercase().contains("cpu")
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum EmbedInput {
  One(String),
  Many(Vec<String>),
}
impl From<String> for EmbedInput {
  fn from(v: String) -> Self { Self::One(v) }
}
impl From<&str> for EmbedInput {
  fn from(v: &str) -> Self { Self::One(v.to_string()) }
}
impl From<Vec<String>> for EmbedInput {
  fn from(v: Vec<String>) -> Self { Self::Many(v) }
}

#[derive(Serialize)]
struct EmbedRequest {
  model: String,
  input: EmbedInput,
  #[serde(skip_serializing_if = "Option::is_none")]
  truncate: Option<bool>,
}

#[derive(Deserialize)]
struct EmbedResponse {
  embeddings: Vec<Vec<f32>>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMessage {
  pub role: String,
  pub content: String,
}

#[derive(Serialize)]
struct ChatRequest {
  model: String,
  messages: Vec<ChatMessage>,
  #[serde(skip_serializing_if = "Option::is_none")]
  stream: Option<bool>,
}

#[derive(Deserialize)]
struct ChatResponse {
  message: Option<ChatMessage>,
}

#[derive(Deserialize)]
struct ChatStreamResponse {
  message: Option<ChatMessage>,
  done: Option<bool>,
  error: Option<String>,
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn normalize_ollama_base_adds_scheme_and_api() {
    assert_eq!(
      normalize_ollama_base("localhost:11434"),
      "http://localhost:11434/api".to_string()
    );
    assert_eq!(
      normalize_ollama_base("http://localhost:11434"),
      "http://localhost:11434/api".to_string()
    );
    assert_eq!(
      normalize_ollama_base("http://localhost:11434/api"),
      "http://localhost:11434/api".to_string()
    );
  }

  #[test]
  fn normalize_ollama_base_handles_trailing_slash_and_empty() {
    assert_eq!(
      normalize_ollama_base("http://localhost:11434/"),
      "http://localhost:11434/api".to_string()
    );
    assert_eq!(
      normalize_ollama_base("   "),
      DEFAULT_OLLAMA_BASE.to_string()
    );
  }

  #[test]
  fn ollama_base_url_uses_env() {
    let prev_base = std::env::var("OLLAMA_BASE_URL").ok();
    let prev_host = std::env::var("OLLAMA_HOST").ok();

    std::env::set_var("OLLAMA_BASE_URL", "example:11434/api");
    std::env::remove_var("OLLAMA_HOST");
    assert_eq!(ollama_base_url(), "http://example:11434/api".to_string());

    if let Some(value) = prev_base {
      std::env::set_var("OLLAMA_BASE_URL", value);
    } else {
      std::env::remove_var("OLLAMA_BASE_URL");
    }

    if let Some(value) = prev_host {
      std::env::set_var("OLLAMA_HOST", value);
    } else {
      std::env::remove_var("OLLAMA_HOST");
    }
  }
}
