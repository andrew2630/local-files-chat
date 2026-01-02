use anyhow::{anyhow, Result};
use reqwest::blocking::Client;
use reqwest::Client as AsyncClient;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_OLLAMA_BASE: &str = "http://127.0.0.1:11434/api";
const DEFAULT_OLLAMA_TIMEOUT_SECS: u64 = 300;

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
    let resp: EmbedResponse = self
      .http
      .post(format!("{}/embed", self.base))
      .json(&req)
      .send()?
      .error_for_status()?
      .json()?;

    Ok(resp.embeddings)
  }

  pub fn chat(&self, model: &str, messages: Vec<ChatMessage>) -> Result<String> {
    let req = ChatRequest {
      model: model.to_string(),
      messages,
      stream: Some(false), // streaming off = prościej do obsługi 
    };

    // /api/chat 
    let resp: ChatResponse = self
      .http
      .post(format!("{}/chat", self.base))
      .json(&req)
      .send()?
      .error_for_status()?
      .json()?;

    resp
      .message
      .map(|m| m.content)
      .ok_or_else(|| anyhow!("No message content in Ollama response"))
  }

  pub fn list_models(&self) -> Result<Vec<String>> {
    let resp: TagsResponse = self
      .http
      .get(format!("{}/tags", self.base))
      .send()?
      .error_for_status()?
      .json()?;

    Ok(resp.models.into_iter().map(|m| m.name).collect())
  }
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
    .await?
    .error_for_status()?;
  let data: TagsResponse = resp.json().await?;
  Ok(data.models.into_iter().map(|m| m.name).collect())
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
