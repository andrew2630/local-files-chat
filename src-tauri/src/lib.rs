mod ollama;
mod library;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::{
  collections::{HashMap, HashSet},
  path::PathBuf,
  sync::{Arc, Mutex},
  time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tauri::Emitter;

#[derive(Clone)]
struct AppState {
  inner: Arc<AppStateInner>,
}

struct AppStateInner {
  watcher: Mutex<Option<RecommendedWatcher>>,
  watched: Mutex<HashSet<PathBuf>>,
  last_event: Mutex<HashMap<PathBuf, Instant>>,
  last_embed_model: Mutex<String>,
  last_index_settings: Mutex<library::IndexSettings>,
  target_files: Mutex<HashSet<PathBuf>>,
  folder_roots: Mutex<Vec<(PathBuf, bool)>>,
}

impl Default for AppState {
  fn default() -> Self {
    let settings = library::IndexSettings {
      chunk_size: 1400,
      chunk_overlap: 250,
      ocr_enabled: true,
      ocr_lang: "pol+eng".into(),
      ocr_min_chars: 120,
      ocr_dpi: 300,
    };
    Self {
      inner: Arc::new(AppStateInner {
        watcher: Mutex::new(None),
        watched: Mutex::new(HashSet::new()),
        last_event: Mutex::new(HashMap::new()),
        last_embed_model: Mutex::new(String::new()),
        last_index_settings: Mutex::new(settings),
        target_files: Mutex::new(HashSet::new()),
        folder_roots: Mutex::new(Vec::new()),
      }),
    }
  }
}

fn update_last_settings(state: &State<AppState>, embed_model: &str, settings: &library::IndexSettings) {
  if let Ok(mut m) = state.inner.last_embed_model.lock() {
    *m = embed_model.to_string();
  }
  if let Ok(mut s) = state.inner.last_index_settings.lock() {
    *s = settings.clone();
  }
}

fn should_process(inner: &AppStateInner, path: &PathBuf) -> bool {
  let mut map = inner.last_event.lock().unwrap();
  let now = Instant::now();
  if let Some(prev) = map.get(path) {
    if now.duration_since(*prev) < Duration::from_secs(2) {
      return false;
    }
  }
  map.insert(path.clone(), now);
  true
}

fn is_in_targets(inner: &AppStateInner, path: &PathBuf) -> bool {
  let target_files = inner.target_files.lock().unwrap();
  if target_files.contains(path) {
    return true;
  }
  let folder_roots = inner.folder_roots.lock().unwrap();
  for (root, recursive) in folder_roots.iter() {
    if *recursive {
      if path.starts_with(root) {
        return true;
      }
    } else if path.parent() == Some(root.as_path()) {
      return true;
    }
  }
  false
}

fn update_watcher(app: &AppHandle, state: &State<AppState>, targets: &[library::IndexTarget]) -> Result<(), String> {
  let inner = state.inner.clone();
  let app_handle = app.clone();

  let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
    match res {
      Ok(event) => {
        let mut files = Vec::new();
        for path in event.paths {
          if !path.is_file() { continue; }
          if !library::is_supported_document(&path) { continue; }
          if !is_in_targets(&inner, &path) { continue; }
          if !should_process(&inner, &path) { continue; }
          files.push(path.to_string_lossy().to_string());
        }

        if files.is_empty() { return; }
        let embed_model = inner.last_embed_model.lock().unwrap().clone();
        if embed_model.is_empty() { return; }
        let settings = inner.last_index_settings.lock().unwrap().clone();
        let app_for_index = app_handle.clone();
        let app_for_error = app_handle.clone();

        tauri::async_runtime::spawn(async move {
          let app_for_error_clone = app_for_error.clone();
          let res = tauri::async_runtime::spawn_blocking(move || {
            library::index_files(&app_for_index, files, embed_model, settings)
          }).await;
          if let Ok(Err(e)) = res {
            let _ = app_for_error_clone.emit("index_error", e.to_string());
          }
        });
      }
      Err(e) => {
        let _ = app_handle.emit("index_error", format!("watcher error: {e}"));
      }
    }
  }).map_err(|e| e.to_string())?;

  let mut watched = HashSet::new();
  let mut target_files = HashSet::new();
  let mut folder_roots = Vec::new();

  for target in targets {
    let path = PathBuf::from(&target.path);
    match target.kind {
      library::IndexTargetKind::File => {
        target_files.insert(path.clone());
        let watch_path = if path.exists() {
          path.clone()
        } else {
          path.parent().map(|p| p.to_path_buf()).unwrap_or(path.clone())
        };
        if watcher.watch(&watch_path, RecursiveMode::NonRecursive).is_ok() {
          watched.insert(watch_path);
        }
      }
      library::IndexTargetKind::Folder => {
        let recursive = target.include_subfolders;
        if watcher.watch(&path, if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive }).is_ok() {
          watched.insert(path.clone());
        }
        folder_roots.push((path, recursive));
      }
    }
  }

  *inner.watcher.lock().unwrap() = Some(watcher);
  *inner.watched.lock().unwrap() = watched;
  *inner.target_files.lock().unwrap() = target_files;
  *inner.folder_roots.lock().unwrap() = folder_roots;
  Ok(())
}

#[tauri::command]
fn start_index(
  app: AppHandle,
  state: State<AppState>,
  targets: Vec<library::IndexTarget>,
  embed_model: String,
  settings: library::IndexSettings,
) -> Result<(), String> {
  update_last_settings(&state, &embed_model, &settings);
  let app_for_error = app.clone();
  tauri::async_runtime::spawn(async move {
    let res = tauri::async_runtime::spawn_blocking(move || {
      library::index_library(app, targets, embed_model, settings)
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
fn chat(
  app: AppHandle,
  question: String,
  llm_model: String,
  embed_model: String,
  settings: library::RetrievalSettings,
) -> Result<library::ChatResult, String> {
  library::chat(&app, question, llm_model, embed_model, settings).map_err(|e| e.to_string())
}

#[tauri::command]
fn reindex_files(
  app: AppHandle,
  state: State<AppState>,
  files: Vec<String>,
  embed_model: String,
  settings: library::IndexSettings,
) -> Result<(), String> {
  update_last_settings(&state, &embed_model, &settings);
  let app_for_error = app.clone();
  tauri::async_runtime::spawn(async move {
    let res = tauri::async_runtime::spawn_blocking(move || {
      library::index_files(&app, files, embed_model, settings)
    }).await;
    if let Ok(Err(e)) = res {
      let _ = app_for_error.emit("index_error", e.to_string());
    }
  });
  Ok(())
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

#[tauri::command]
fn list_targets(app: AppHandle) -> Result<Vec<library::IndexTarget>, String> {
  library::list_targets(&app).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_targets(app: AppHandle, state: State<AppState>, targets: Vec<library::IndexTarget>) -> Result<(), String> {
  library::save_targets(&app, targets.clone()).map_err(|e| e.to_string())?;
  update_watcher(&app, &state, &targets)?;
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(AppState::default())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      let state = app.state::<AppState>();
      if let Ok(targets) = library::list_targets(&app.handle()) {
        let _ = update_watcher(&app.handle(), &state, &targets);
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      start_index,
      chat,
      reindex_files,
      preview_index,
      list_models,
      list_targets,
      save_targets
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
