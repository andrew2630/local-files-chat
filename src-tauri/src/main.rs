#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use tauri::{Manager};

mod rag;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceHit {
  pub path: String,
  pub page: i32,
  pub snippet: String,
  pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
  pub answer: String,
  pub sources: Vec<SourceHit>,
}

#[tauri::command]
async fn chat(query: String, roots: Vec<String>, chat_model: String, embed_model: String) -> Result<ChatResponse, String> {
  rag::chat(query, roots, chat_model, embed_model).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_index(roots: Vec<String>, embed_model: String) -> Result<(), String> {
  rag::index(roots, embed_model).await.map_err(|e| e.to_string())
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![chat, start_index])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
