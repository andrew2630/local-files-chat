mod ollama;
mod library;

use tauri::AppHandle;

#[tauri::command]
fn start_index(app: AppHandle, targets: Vec<library::IndexTarget>, embed_model: String) -> Result<(), String> {
  let app_for_error = app.clone();
  tauri::async_runtime::spawn(async move {
    let res = tauri::async_runtime::spawn_blocking(move || {
      library::index_library(app, targets, embed_model)
    }).await;

    match res {
      Ok(Ok(())) => {}
      Ok(Err(e)) => {
        let _ = app_for_error.emit("index_error", e.to_string());
      }
      Err(e) => {
        let _ = app_for_error.emit("index_error", format!("index task join error: {e}"));
      }
    }
  });
  Ok(())
}

#[tauri::command]
fn chat(app: AppHandle, question: String, llm_model: String, embed_model: String, top_k: i64) -> Result<library::ChatResult, String> {
  library::chat(&app, question, llm_model, embed_model, top_k).map_err(|e| e.to_string())
}

#[tauri::command]
fn preview_index(app: AppHandle, targets: Vec<library::IndexTarget>) -> Result<Vec<library::IndexFilePreview>, String> {
  library::preview_index(&app, targets).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_models() -> Result<Vec<String>, String> {
  let ollama = ollama::Ollama::new();
  ollama.list_models().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![start_index, chat, preview_index, list_models])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
