use anyhow::{anyhow, Result};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};

const OLLAMA_BASE: &str = "http://localhost:11434/api";

#[derive(Clone)]
pub struct Ollama {
  http: Client,
}

impl Ollama {
  pub fn new() -> Self {
    Self { http: Client::new() }
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
      .post(format!("{OLLAMA_BASE}/embed"))
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
      .post(format!("{OLLAMA_BASE}/chat"))
      .json(&req)
      .send()?
      .error_for_status()?
      .json()?;

    resp
      .message
      .map(|m| m.content)
      .ok_or_else(|| anyhow!("No message content in Ollama response"))
  }
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
