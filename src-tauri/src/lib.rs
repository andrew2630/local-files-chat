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
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![start_index, chat])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
