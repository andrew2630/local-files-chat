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

mod ollama;
mod library;

use tauri::AppHandle;

#[tauri::command]
fn start_index(app: AppHandle, roots: Vec<String>, embed_model: String) -> Result<(), String> {
  tauri::async_runtime::spawn(async move {
    let res = tauri::async_runtime::spawn_blocking(move || {
      library::index_library(app, roots, embed_model)
    }).await;

    if let Err(e) = res {
      eprintln!("index task join error: {e}");
    }
  });
  Ok(())
}

#[tauri::command]
fn chat(app: AppHandle, question: String, llm_model: String, embed_model: String, top_k: i64) -> Result<library::ChatResult, String> {
  library::chat(&app, question, llm_model, embed_model, top_k).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![start_index, chat])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
