mod ollama;
mod library;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
  collections::{HashMap, HashSet},
  io::{BufRead, BufReader},
  path::PathBuf,
  process::{Command, Stdio},
  sync::{Arc, Mutex},
  time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tauri::Emitter;

const DEFAULT_CHAT_MODEL: &str = "llama3.1:8b";
const DEFAULT_FAST_CHAT_MODEL: &str = "llama3.2:3b";
const DEFAULT_EMBED_MODEL: &str = "qwen3-embedding";

fn split_model_tag(name: &str) -> (&str, Option<&str>) {
  match name.split_once(':') {
    Some((base, tag)) => (base, Some(tag)),
    None => (name, None),
  }
}

fn model_installed(models: &[String], required: &str) -> bool {
  let (req_base, req_tag) = split_model_tag(required);
  models.iter().any(|model| {
    let (base, tag) = split_model_tag(model);
    if req_tag.is_some() {
      model == required || (tag.is_none() && base == req_base)
    } else {
      base == req_base
    }
  })
}

fn panic_message(panic: Box<dyn std::any::Any + Send>) -> String {
  let panic_ref = panic.as_ref();
  if let Some(s) = panic_ref.downcast_ref::<&str>() {
    (*s).to_string()
  } else if let Some(s) = panic_ref.downcast_ref::<String>() {
    s.clone()
  } else {
    "unknown panic".to_string()
  }
}

fn run_index_task(task: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
  match std::panic::catch_unwind(std::panic::AssertUnwindSafe(task)) {
    Ok(result) => result,
    Err(panic) => Err(format!("index task panicked: {}", panic_message(panic))),
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupStatus {
  running: bool,
  models: Vec<String>,
  default_chat: String,
  default_fast: String,
  default_embed: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupProgress {
  stage: String,
  message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelPullProgress {
  model: String,
  line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatcherStatus {
  status: String,
  watched: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReindexProgress {
  status: String,
  files: Vec<String>,
}

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

fn emit_setup_progress(app: &AppHandle, stage: &str, message: impl Into<String>) {
  let _ = app.emit(
    "setup_progress",
    SetupProgress {
      stage: stage.to_string(),
      message: message.into(),
    },
  );
}

fn emit_setup_error(app: &AppHandle, message: impl Into<String>) {
  let _ = app.emit("setup_error", message.into());
}

#[tauri::command]
fn set_ollama_host(host: String) -> Result<(), String> {
  let trimmed = host.trim();
  if trimmed.is_empty() {
    std::env::remove_var("OLLAMA_BASE_URL");
  } else {
    std::env::set_var("OLLAMA_BASE_URL", trimmed);
  }
  Ok(())
}

fn run_ollama_pull(app: &AppHandle, model: &str) -> Result<(), String> {
  let mut child = Command::new("ollama")
    .arg("pull")
    .arg(model)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| format!("failed to run ollama pull {model}: {e}"))?;

  let stdout = child.stdout.take().ok_or("failed to capture ollama stdout")?;
  let stderr = child.stderr.take().ok_or("failed to capture ollama stderr")?;

  let app_out = app.clone();
  let model_out = model.to_string();
  let out_handle = std::thread::spawn(move || {
    for line in BufReader::new(stdout).lines().flatten() {
      let _ = app_out.emit(
        "model_pull_progress",
        ModelPullProgress {
          model: model_out.clone(),
          line,
        },
      );
    }
  });

  let app_err = app.clone();
  let model_err = model.to_string();
  let err_handle = std::thread::spawn(move || {
    for line in BufReader::new(stderr).lines().flatten() {
      let _ = app_err.emit(
        "model_pull_progress",
        ModelPullProgress {
          model: model_err.clone(),
          line: format!("ERR: {line}"),
        },
      );
    }
  });

  let status = child
    .wait()
    .map_err(|e| format!("ollama pull failed for {model}: {e}"))?;

  let _ = out_handle.join();
  let _ = err_handle.join();

  if !status.success() {
    return Err(format!("ollama pull failed for {model}"));
  }
  Ok(())
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

  let inner_for_watcher = inner.clone();
  let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
    match res {
      Ok(event) => {
        let mut files = Vec::new();
        for path in event.paths {
          if !path.is_file() { continue; }
          if !library::is_supported_document(&path) { continue; }
          if !is_in_targets(&inner_for_watcher, &path) { continue; }
          if !should_process(&inner_for_watcher, &path) { continue; }
          files.push(path.to_string_lossy().to_string());
        }

        if files.is_empty() { return; }
        let embed_model = inner_for_watcher.last_embed_model.lock().unwrap().clone();
        if embed_model.is_empty() { return; }
        let settings = inner_for_watcher.last_index_settings.lock().unwrap().clone();
        let app_for_index = app_handle.clone();
        let app_for_error = app_handle.clone();
        let files_for_done = files.clone();

        let _ = app_handle.emit(
          "reindex_progress",
          ReindexProgress {
            status: "queued".into(),
            files: files.clone(),
          },
        );

        tauri::async_runtime::spawn(async move {
          let app_for_error_clone = app_for_error.clone();
          let res = tauri::async_runtime::spawn_blocking(move || {
            run_index_task(|| {
            library::index_files(&app_for_index, files, embed_model, settings)
                .map_err(|e| format!("{:#}", e))
            })
          }).await;
          match res {
            Ok(Ok(())) => {
              let _ = app_for_error_clone.emit(
                "reindex_progress",
                ReindexProgress {
                  status: "done".into(),
                  files: files_for_done,
                },
              );
            }
            Ok(Err(e)) => {
              let _ = app_for_error_clone.emit("index_error", e.to_string());
              let _ = app_for_error_clone.emit(
                "reindex_progress",
                ReindexProgress {
                  status: "error".into(),
                  files: files_for_done,
                },
              );
            }
            Err(e) => {
              let _ = app_for_error_clone.emit("index_error", format!("reindex task join error: {e}"));
              let _ = app_for_error_clone.emit(
                "reindex_progress",
                ReindexProgress {
                  status: "error".into(),
                  files: files_for_done,
                },
              );
            }
          }
        });
      }
      Err(e) => {
        let _ = app_handle.emit("index_error", format!("watcher error: {e}"));
        let _ = app_handle.emit(
          "watcher_status",
          WatcherStatus {
            status: "error".into(),
            watched: 0,
          },
        );
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
  let _ = app.emit(
    "watcher_status",
    WatcherStatus {
      status: "watching".into(),
      watched: inner.watched.lock().unwrap().len(),
    },
  );
  Ok(())
}

#[tauri::command]
async fn setup_status() -> Result<SetupStatus, String> {
  let timeout = Duration::from_secs(2);
  match ollama::list_models_with_timeout(timeout).await {
    Ok(models) => Ok(SetupStatus {
      running: true,
      models,
      default_chat: DEFAULT_CHAT_MODEL.to_string(),
      default_fast: DEFAULT_FAST_CHAT_MODEL.to_string(),
      default_embed: DEFAULT_EMBED_MODEL.to_string(),
    }),
    Err(_) => Ok(SetupStatus {
      running: false,
      models: vec![],
      default_chat: DEFAULT_CHAT_MODEL.to_string(),
      default_fast: DEFAULT_FAST_CHAT_MODEL.to_string(),
      default_embed: DEFAULT_EMBED_MODEL.to_string(),
    }),
  }
}

#[tauri::command]
fn run_setup(app: AppHandle) -> Result<(), String> {
  let app_handle = app.clone();
  tauri::async_runtime::spawn(async move {
    emit_setup_progress(&app_handle, "check", "Checking Ollama...");
    let timeout = Duration::from_secs(2);
    let models = match ollama::list_models_with_timeout(timeout).await {
      Ok(models) => models,
      Err(e) => {
        emit_setup_error(&app_handle, format!("Ollama is not running: {e}"));
        return;
      }
    };

    let mut missing = Vec::new();
    if !model_installed(&models, DEFAULT_CHAT_MODEL) {
      missing.push(DEFAULT_CHAT_MODEL.to_string());
    }
    if !model_installed(&models, DEFAULT_FAST_CHAT_MODEL) {
      missing.push(DEFAULT_FAST_CHAT_MODEL.to_string());
    }
    if !model_installed(&models, DEFAULT_EMBED_MODEL) {
      missing.push(DEFAULT_EMBED_MODEL.to_string());
    }

    if missing.is_empty() {
      emit_setup_progress(&app_handle, "done", "All required models are already installed.");
      let _ = app_handle.emit("setup_done", true);
      return;
    }

    let app_for_pull = app_handle.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
      for model in missing {
        emit_setup_progress(&app_for_pull, "pull", format!("Pulling {model}..."));
        run_ollama_pull(&app_for_pull, &model)?;
      }
      Ok::<(), String>(())
    }).await;

    match res {
      Ok(Ok(())) => {
        emit_setup_progress(&app_handle, "done", "Setup complete.");
        let _ = app_handle.emit("setup_done", true);
      }
      Ok(Err(e)) => {
        emit_setup_error(&app_handle, e);
      }
      Err(e) => {
        emit_setup_error(&app_handle, format!("setup task join error: {e}"));
      }
    }
  });
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
      run_index_task(|| {
        library::index_library(app, targets, embed_model, settings)
          .map_err(|e| format!("{:#}", e))
      })
    }).await;

    match res {
      Ok(Ok(())) => {}
      Ok(Err(e)) => {
        let _ = app_for_error.emit("index_error", e);
      }
      Err(e) => {
        let _ = app_for_error.emit("index_error", format!("index task join error: {e}"));
      }
    }
  });
  Ok(())
}

#[tauri::command]
async fn chat(
  app: AppHandle,
  question: String,
  llm_model: String,
  embed_model: String,
  settings: library::RetrievalSettings,
) -> Result<library::ChatResult, String> {
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    library::chat(&app, question, llm_model, embed_model, settings)
      .map_err(|e| format!("{:#}", e))
  })
  .await
  .map_err(|e| format!("chat task join error: {e}"))?
}

#[tauri::command]
async fn chat_stream(
  app: AppHandle,
  question: String,
  llm_model: String,
  embed_model: String,
  settings: library::RetrievalSettings,
) -> Result<library::ChatResult, String> {
  let app = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    library::chat_stream(&app, question, llm_model, embed_model, settings)
      .map_err(|e| format!("{:#}", e))
  })
  .await
  .map_err(|e| format!("chat task join error: {e}"))?
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
      run_index_task(|| {
        library::index_files(&app, files, embed_model, settings)
          .map_err(|e| format!("{:#}", e))
      })
    }).await;
    match res {
      Ok(Ok(())) => {}
      Ok(Err(e)) => {
        let _ = app_for_error.emit("index_error", e);
      }
      Err(e) => {
        let _ = app_for_error.emit("index_error", format!("index task join error: {e}"));
      }
    }
  });
  Ok(())
}

#[tauri::command]
fn preview_index(app: AppHandle, targets: Vec<library::IndexTarget>) -> Result<Vec<library::IndexFilePreview>, String> {
  library::preview_index(&app, targets).map_err(|e| format!("{:#}", e))
}

#[tauri::command]
fn list_models() -> Result<Vec<String>, String> {
  let ollama = ollama::Ollama::new();
  ollama.list_models().map_err(|e| format!("{:#}", e))
}

#[tauri::command]
fn list_targets(app: AppHandle) -> Result<Vec<library::IndexTarget>, String> {
  library::list_targets(&app).map_err(|e| format!("{:#}", e))
}

#[tauri::command]
fn save_targets(app: AppHandle, state: State<AppState>, targets: Vec<library::IndexTarget>) -> Result<(), String> {
  library::save_targets(&app, targets.clone()).map_err(|e| format!("{:#}", e))?;
  update_watcher(&app, &state, &targets)?;
  Ok(())
}

#[tauri::command]
fn prune_index(app: AppHandle, targets: Vec<library::IndexTarget>) -> Result<usize, String> {
  library::prune_index(&app, targets).map_err(|e| format!("{:#}", e))
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
      set_ollama_host,
      setup_status,
      run_setup,
      start_index,
      chat,
      chat_stream,
      reindex_files,
      preview_index,
      list_models,
      list_targets,
      save_targets,
      prune_index
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::{HashMap, HashSet};
  use std::path::PathBuf;
  use std::sync::Mutex;

  #[test]
  fn split_model_tag_parses_tags() {
    assert_eq!(split_model_tag("llama3:8b"), ("llama3", Some("8b")));
    assert_eq!(split_model_tag("llama3"), ("llama3", None));
  }

  #[test]
  fn model_installed_accepts_base_match() {
    assert!(model_installed(&["llama3".into()], "llama3:8b"));
    assert!(!model_installed(&["llama3:7b".into()], "llama3:8b"));
    assert!(model_installed(&["llama3:8b".into()], "llama3"));
  }

  #[test]
  fn panic_message_handles_known_types() {
    assert_eq!(panic_message(Box::new("boom")), "boom".to_string());
    assert_eq!(panic_message(Box::new(String::from("oops"))), "oops".to_string());
    assert_eq!(panic_message(Box::new(42u8)), "unknown panic".to_string());
  }

  #[test]
  fn run_index_task_catches_panics() {
    let ok = run_index_task(|| Ok(()));
    assert!(ok.is_ok());

    let err = run_index_task(|| -> Result<(), String> {
      panic!("boom");
    })
    .unwrap_err();
    assert!(err.contains("index task panicked"));
  }

  #[test]
  fn should_process_dedupes_events() {
    let settings = library::IndexSettings {
      chunk_size: 1400,
      chunk_overlap: 250,
      ocr_enabled: true,
      ocr_lang: "pol+eng".into(),
      ocr_min_chars: 120,
      ocr_dpi: 300,
    };

    let inner = AppStateInner {
      watcher: Mutex::new(None),
      watched: Mutex::new(HashSet::new()),
      last_event: Mutex::new(HashMap::new()),
      last_embed_model: Mutex::new(String::new()),
      last_index_settings: Mutex::new(settings),
      target_files: Mutex::new(HashSet::new()),
      folder_roots: Mutex::new(Vec::new()),
    };

    let path = PathBuf::from("C:\\temp\\file.txt");
    assert!(should_process(&inner, &path));
    assert!(!should_process(&inner, &path));
  }
}
