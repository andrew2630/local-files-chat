use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
  collections::{HashMap, HashSet},
  fs,
  io::Read,
  path::{Path, PathBuf},
  process::Command,
  time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};
use tauri::path::BaseDirectory;
use walkdir::WalkDir;
use whatlang::detect;
use rusqlite::{params, Connection, LoadExtensionGuard};
use quick_xml::Reader;
use quick_xml::events::Event;
use zip::ZipArchive;
use tauri::Manager;

use crate::ollama::{ChatMessage, Ollama};

const DB_NAME: &str = "library.sqlite3";

#[derive(Serialize, Clone)]
pub struct IndexProgress {
  pub current: usize,
  pub total: usize,
  pub file: String,
  pub status: String,
}

#[derive(Serialize)]
pub struct Source {
  pub file_path: String,
  pub page: i32,
  pub snippet: String,
  pub distance: f64,
}

#[derive(Serialize)]
pub struct ChatResult {
  pub answer: String,
  pub sources: Vec<Source>,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum IndexTargetKind {
  File,
  Folder,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexTarget {
  pub path: String,
  pub kind: IndexTargetKind,
  #[serde(default)]
  pub include_subfolders: bool,
}

#[derive(Serialize)]
pub struct IndexFilePreview {
  pub path: String,
  pub kind: String,
  pub status: String,
  pub size: i64,
  pub mtime: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexSettings {
  pub chunk_size: usize,
  pub chunk_overlap: usize,
  pub ocr_enabled: bool,
  pub ocr_lang: String,
  pub ocr_min_chars: usize,
  pub ocr_dpi: u16,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalSettings {
  pub top_k: i64,
  pub max_distance: Option<f64>,
  pub use_mmr: bool,
  pub mmr_lambda: f64,
  pub mmr_candidates: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DocumentKind {
  Pdf,
  Txt,
  Md,
  Docx,
}

impl DocumentKind {
  fn as_str(self) -> &'static str {
    match self {
      DocumentKind::Pdf => "pdf",
      DocumentKind::Txt => "txt",
      DocumentKind::Md => "md",
      DocumentKind::Docx => "docx",
    }
  }
}

#[derive(Clone)]
struct DocumentCandidate {
  path: PathBuf,
  kind: DocumentKind,
}

fn app_db_path(app: &AppHandle) -> Result<PathBuf> {
  // PathResolver ma app_local_data_dir, app_data_dir itd. 
  let dir = app.path().app_local_data_dir()?;
  fs::create_dir_all(&dir)?;
  Ok(dir.join(DB_NAME))
}

fn vec0_dll_path(app: &AppHandle) -> Result<PathBuf> {
  if let Ok(p) = app.path().resolve("vec0.dll", BaseDirectory::Resource) {
    return Ok(p);
  }
  Ok(app.path().resolve("resources/vec0.dll", BaseDirectory::Resource)?)
}

fn open_db(app: &AppHandle) -> Result<Connection> {
  let db_path = app_db_path(app)?;
  let conn = Connection::open(db_path)?;

  conn.execute_batch(
    "PRAGMA journal_mode=WAL;
     PRAGMA synchronous=NORMAL;"
  )?;

  let vec_path = vec0_dll_path(app)?;

  unsafe {
    let _guard = LoadExtensionGuard::new(&conn)?;
    conn.load_extension(vec_path, None)?;
  }

  Ok(conn)
}

fn ensure_schema(conn: &Connection, dim: usize, settings: &IndexSettings) -> Result<()> {
  conn.execute_batch(
    "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);

     CREATE TABLE IF NOT EXISTS files(
       path TEXT PRIMARY KEY,
       kind TEXT,
       hash TEXT NOT NULL,
       size INTEGER,
       mtime INTEGER,
       indexed_at INTEGER
     );

     CREATE TABLE IF NOT EXISTS chunks(
       id INTEGER PRIMARY KEY,
       file_path TEXT NOT NULL,
       page INTEGER NOT NULL,
       chunk_index INTEGER NOT NULL,
       lang TEXT,
       text TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);"
  )?;

  conn.execute_batch(
    "CREATE TABLE IF NOT EXISTS targets(
       path TEXT NOT NULL,
       kind TEXT NOT NULL,
       include_subfolders INTEGER NOT NULL,
       added_at INTEGER NOT NULL,
       PRIMARY KEY(path, kind)
     );"
  )?;

  let _ = conn.execute("ALTER TABLE files ADD COLUMN kind TEXT", []);

  // check dim
  let old_dim: Option<i64> = conn.query_row(
    "SELECT value FROM meta WHERE key='embedding_dim'",
    [],
    |r| r.get::<_, String>(0)
  ).ok().and_then(|s| s.parse::<i64>().ok());

  let old_chunk_size: Option<i64> = conn
    .query_row("SELECT value FROM meta WHERE key='chunk_size'", [], |r| r.get::<_, String>(0))
    .ok()
    .and_then(|s| s.parse::<i64>().ok());
  let old_chunk_overlap: Option<i64> = conn
    .query_row("SELECT value FROM meta WHERE key='chunk_overlap'", [], |r| r.get::<_, String>(0))
    .ok()
    .and_then(|s| s.parse::<i64>().ok());

  let schema_changed = match old_dim {
    Some(old) if old as usize != dim => true,
    _ => false,
  } || match old_chunk_size {
    Some(old) if old as usize != settings.chunk_size => true,
    _ => false,
  } || match old_chunk_overlap {
    Some(old) if old as usize != settings.chunk_overlap => true,
    _ => false,
  };

  if schema_changed {
    conn.execute_batch(
      "DROP TABLE IF EXISTS vec_chunks;
       DELETE FROM chunks;
       DELETE FROM files;
       DELETE FROM meta WHERE key IN ('embedding_dim','chunk_size','chunk_overlap');"
    )?;
  }

  conn.execute(
    "INSERT OR REPLACE INTO meta(key,value) VALUES('embedding_dim', ?)",
    params![dim.to_string()],
  )?;
  conn.execute(
    "INSERT OR REPLACE INTO meta(key,value) VALUES('chunk_size', ?)",
    params![settings.chunk_size.to_string()],
  )?;
  conn.execute(
    "INSERT OR REPLACE INTO meta(key,value) VALUES('chunk_overlap', ?)",
    params![settings.chunk_overlap.to_string()],
  )?;

  // vec0 virtual table (sqlite-vec) + cosine, KNN 
  conn.execute_batch(&format!(
    "CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks
     USING vec0(embedding float[{dim}] distance_metric=cosine);"
  ))?;

  Ok(())
}

fn kind_from_path(p: &Path) -> Option<DocumentKind> {
  let ext = p.extension()?.to_str()?.to_ascii_lowercase();
  match ext.as_str() {
    "pdf" => Some(DocumentKind::Pdf),
    "txt" => Some(DocumentKind::Txt),
    "md" | "markdown" => Some(DocumentKind::Md),
    "docx" => Some(DocumentKind::Docx),
    _ => None,
  }
}

pub fn is_supported_document(path: &Path) -> bool {
  kind_from_path(path).is_some()
}

fn list_documents(targets: &[IndexTarget]) -> Vec<DocumentCandidate> {
    let mut out = vec![];
    let mut seen: HashSet<String> = HashSet::new();

    for target in targets {
        let base = PathBuf::from(&target.path);
        match target.kind {
            IndexTargetKind::File => {
                if base.is_file() {
                    if let Some(kind) = kind_from_path(&base) {
                        let key = base.to_string_lossy().to_string();
                        if seen.insert(key) {
                            out.push(DocumentCandidate { path: base.clone(), kind }); // Clone base here
                        }
                    }
                }
            }
            IndexTargetKind::Folder => {
                if !base.is_dir() {
                    continue;
                }
                let walker = if target.include_subfolders {
                    WalkDir::new(&base)
                } else {
                    WalkDir::new(&base).max_depth(1)
                };

                for e in walker.into_iter().filter_map(|e| e.ok()) {
                    if !e.file_type().is_file() {
                        continue;
                    }
                    let p = e.path();
                    if let Some(kind) = kind_from_path(p) {
                        let key = p.to_string_lossy().to_string();
                        if seen.insert(key) {
                            out.push(DocumentCandidate { path: p.to_path_buf(), kind });
                        }
                    }
                }
            }
        }
    }

    out
}

#[derive(Clone)]
struct PreviewCandidate {
  path: PathBuf,
  kind: DocumentKind,
  exists: bool,
}

fn list_preview_items(targets: &[IndexTarget]) -> Vec<PreviewCandidate> {
    let mut out = vec![];
    let mut seen: HashSet<String> = HashSet::new();

    for target in targets {
        let base = PathBuf::from(&target.path);
        match target.kind {
            IndexTargetKind::File => {
                if let Some(kind) = kind_from_path(&base) {
                    let key = base.to_string_lossy().to_string();
                    if seen.insert(key) {
                        out.push(PreviewCandidate { path: base.clone(), kind, exists: base.is_file() }); // Clone base here
                    }
                }
            }
            IndexTargetKind::Folder => {
                if !base.is_dir() {
                    continue;
                }
                let walker = if target.include_subfolders {
                    WalkDir::new(&base)
                } else {
                    WalkDir::new(&base).max_depth(1)
                };

                for e in walker.into_iter().filter_map(|e| e.ok()) {
                    if !e.file_type().is_file() {
                        continue;
                    }
                    let p = e.path();
                    if let Some(kind) = kind_from_path(p) {
                        let key = p.to_string_lossy().to_string();
                        if seen.insert(key) {
                            out.push(PreviewCandidate { path: p.to_path_buf(), kind, exists: true });
                        }
                    }
                }
            }
        }
    }

    out
}

fn file_fingerprint(p: &Path) -> Result<(String, i64, i64)> {
  let md = fs::metadata(p)?;
  let size = md.len() as i64;
  let mtime = md.modified()
    .ok()
    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    .map(|d| d.as_secs() as i64)
    .unwrap_or(0);

  let mut h = Sha256::new();
  h.update(p.to_string_lossy().as_bytes());
  h.update(size.to_le_bytes());
  h.update(mtime.to_le_bytes());
  let hash = format!("{:x}", h.finalize());
  Ok((hash, size, mtime))
}

fn chunk_text(s: &str, max_chars: usize, overlap: usize) -> Vec<String> {
  let s = s.trim();
  if s.is_empty() || max_chars == 0 { return vec![]; }

  let mut out = vec![];
  let mut start = 0usize;
  let bytes = s.as_bytes();
  let overlap = overlap.min(max_chars.saturating_sub(1));

  while start < bytes.len() {
    let end = usize::min(start + max_chars, bytes.len());
    let chunk = String::from_utf8_lossy(&bytes[start..end]).trim().to_string();
    if !chunk.is_empty() { out.push(chunk); }
    if end == bytes.len() { break; }
    start = end.saturating_sub(overlap);
  }
  out
}

fn clean_text(s: &str) -> String {
  s.replace('\u{0}', " ").trim().to_string()
}

fn split_pages(raw: &str) -> Vec<String> {
  let parts = if raw.contains('\x0C') {
    raw.split('\x0C').collect::<Vec<_>>()
  } else if raw.contains('\u{000C}') {
    raw.split('\u{000C}').collect::<Vec<_>>()
  } else {
    vec![raw]
  };

  parts
    .into_iter()
    .map(clean_text)
    .filter(|s| !s.is_empty())
    .collect()
}

fn tesseract_bin_path(app: &AppHandle) -> Option<PathBuf> {
  let candidates = [
    "tesseract/tesseract.exe",
    "tesseract/tesseract",
    "tesseract.exe",
    "tesseract",
    "resources/tesseract/tesseract.exe",
    "resources/tesseract/tesseract",
    "resources/tesseract.exe",
    "resources/tesseract",
  ];

  for rel in candidates {
    if let Ok(p) = app.path().resolve(rel, BaseDirectory::Resource) {
      if p.exists() {
        return Some(p);
      }
    }
  }
  None
}

fn tessdata_dir(app: &AppHandle) -> Option<PathBuf> {
  let candidates = ["tesseract/tessdata", "resources/tesseract/tessdata"];
  for rel in candidates {
    if let Ok(p) = app.path().resolve(rel, BaseDirectory::Resource) {
      if p.exists() {
        return Some(p);
      }
    }
  }
  None
}

fn run_tesseract(app: &AppHandle, path: &Path, settings: &IndexSettings) -> Result<String> {
  let mut cmd = if let Some(bin) = tesseract_bin_path(app) {
    Command::new(bin)
  } else {
    Command::new("tesseract")
  };

  cmd.arg(path)
    .arg("stdout")
    .arg("-l")
    .arg(&settings.ocr_lang)
    .arg("--dpi")
    .arg(settings.ocr_dpi.to_string());

  if let Some(tessdata) = tessdata_dir(app) {
    cmd.arg("--tessdata-dir").arg(tessdata);
  }

  let out = cmd.output().context("Failed to run tesseract")?;
  if !out.status.success() {
    let err = String::from_utf8_lossy(&out.stderr);
    anyhow::bail!("tesseract failed: {err}");
  }

  Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn extract_pdf_text(app: &AppHandle, path: &Path, settings: &IndexSettings) -> Result<Vec<String>> {
  let raw = match pdf_extract::extract_text(path) {
    Ok(text) => text,
    Err(e) => {
      if settings.ocr_enabled {
        let ocr = run_tesseract(app, path, settings)
          .with_context(|| format!("tesseract OCR failed for {}", path.display()))?;
        return Ok(split_pages(&ocr));
      }
      return Err(e.into());
    }
  };

  let cleaned = clean_text(&raw);
  if settings.ocr_enabled && cleaned.chars().count() < settings.ocr_min_chars {
    if let Ok(ocr) = run_tesseract(app, path, settings) {
      return Ok(split_pages(&ocr));
    }
  }

  Ok(split_pages(&cleaned))
}

fn extract_docx_text(path: &Path) -> Result<String> {
  let file = fs::File::open(path)?;
  let mut archive = ZipArchive::new(file)?;
  let mut doc = archive.by_name("word/document.xml")?;
  let mut xml = String::new();
  doc.read_to_string(&mut xml)?;

  let mut reader = Reader::from_str(&xml);
  reader.trim_text(true);
  let mut buf = Vec::new();
  let mut out = String::new();

  loop {
    match reader.read_event_into(&mut buf) {
      Ok(Event::Text(e)) => {
        out.push_str(&e.unescape()?.to_string());
      }
      Ok(Event::End(e)) => {
        if e.name().as_ref() == b"w:p" {
          out.push('\n');
        }
      }
      Ok(Event::Eof) => break,
      Err(e) => return Err(anyhow::anyhow!("docx parse error: {e}")),
      _ => {}
    }
    buf.clear();
  }

  Ok(out)
}

fn extract_text_for_document(app: &AppHandle, doc: &DocumentCandidate, settings: &IndexSettings) -> Result<Vec<String>> {
  match doc.kind {
    DocumentKind::Pdf => extract_pdf_text(app, &doc.path, settings),
    DocumentKind::Docx => {
      let text = extract_docx_text(&doc.path)?;
      Ok(vec![clean_text(&text)])
    }
    DocumentKind::Txt | DocumentKind::Md => {
      let raw = fs::read_to_string(&doc.path)?;
      Ok(vec![clean_text(&raw)])
    }
  }
}

fn detect_lang_code(text: &str) -> Option<String> {
  detect(text).map(|i| i.lang().code().to_string())
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
  if a.len() != b.len() || a.is_empty() {
    return 0.0;
  }
  let mut dot = 0.0f64;
  let mut norm_a = 0.0f64;
  let mut norm_b = 0.0f64;
  for i in 0..a.len() {
    let av = a[i] as f64;
    let bv = b[i] as f64;
    dot += av * bv;
    norm_a += av * av;
    norm_b += bv * bv;
  }
  if norm_a == 0.0 || norm_b == 0.0 {
    return 0.0;
  }
  dot / (norm_a.sqrt() * norm_b.sqrt())
}

fn now_ts() -> i64 {
  SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

fn has_table(conn: &Connection, name: &str) -> Result<bool> {
  let exists: Option<i32> = conn
    .query_row(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1",
      params![name],
      |r| r.get(0),
    )
    .ok();
  Ok(exists.is_some())
}

fn load_indexed_hashes(conn: &Connection) -> Result<HashMap<String, String>> {
  if !has_table(conn, "files")? {
    return Ok(HashMap::new());
  }

  let mut map = HashMap::new();
  let mut stmt = conn.prepare("SELECT path, hash FROM files")?;
  let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
  for row in rows {
    let (path, hash) = row?;
    map.insert(path, hash);
  }
  Ok(map)
}

fn ensure_targets_schema(conn: &Connection) -> Result<()> {
  conn.execute_batch(
    "CREATE TABLE IF NOT EXISTS targets(
       path TEXT NOT NULL,
       kind TEXT NOT NULL,
       include_subfolders INTEGER NOT NULL,
       added_at INTEGER NOT NULL,
       PRIMARY KEY(path, kind)
     );"
  )?;
  Ok(())
}

pub fn list_targets(app: &AppHandle) -> Result<Vec<IndexTarget>> {
  let mut conn = open_db(app)?;
  ensure_targets_schema(&conn)?;

  let mut targets = vec![];
  let mut stmt = conn.prepare("SELECT path, kind, include_subfolders FROM targets ORDER BY added_at ASC")?;
  let rows = stmt.query_map([], |r| {
    let path: String = r.get(0)?;
    let kind_str: String = r.get(1)?;
    let include_subfolders: i64 = r.get(2)?;
    let kind = if kind_str == "folder" { IndexTargetKind::Folder } else { IndexTargetKind::File };
    Ok(IndexTarget {
      path,
      kind,
      include_subfolders: include_subfolders != 0,
    })
  })?;

  for row in rows {
    targets.push(row?);
  }
  Ok(targets)
}

pub fn save_targets(app: &AppHandle, targets: Vec<IndexTarget>) -> Result<()> {
  let mut conn = open_db(app)?;
  ensure_targets_schema(&conn)?;
  let tx = conn.transaction()?;
  tx.execute("DELETE FROM targets", [])?;

  for target in targets {
    let kind = match target.kind {
      IndexTargetKind::Folder => "folder",
      IndexTargetKind::File => "file",
    };
    tx.execute(
      "INSERT OR REPLACE INTO targets(path, kind, include_subfolders, added_at) VALUES(?1, ?2, ?3, ?4)",
      params![target.path, kind, if target.include_subfolders { 1 } else { 0 }, now_ts()]
    )?;
  }

  tx.commit()?;
  Ok(())
}

fn index_documents(
  app: &AppHandle,
  docs: Vec<DocumentCandidate>,
  embed_model: &str,
  settings: &IndexSettings,
  emit_progress: bool,
) -> Result<()> {
  let ollama = Ollama::new();

  let test = ollama.embed(embed_model, "dim probe")?;
  let dim = test.get(0).map(|v| v.len()).unwrap_or(0);
  anyhow::ensure!(dim > 0, "Embedding dim is 0 (model embed failed?)");

  let mut conn = open_db(app)?;
  ensure_schema(&conn, dim, settings)?;

  let total = docs.len();
  if emit_progress {
    app.emit("index_progress", IndexProgress { current: 0, total, file: "".into(), status: "start".into() })?;
  }

  for (i, doc) in docs.into_iter().enumerate() {
    if !doc.path.is_file() {
      if emit_progress {
        app.emit("index_progress", IndexProgress { current: i + 1, total, file: doc.path.to_string_lossy().to_string(), status: "missing".into() })?;
      }
      continue;
    }

    let file_str = doc.path.to_string_lossy().to_string();
    let (hash, size, mtime) = file_fingerprint(&doc.path)?;

    let old_hash: Option<String> = conn.query_row(
      "SELECT hash FROM files WHERE path=?1",
      params![file_str],
      |r| r.get(0)
    ).ok();

    if old_hash.as_deref() == Some(&hash) {
      if emit_progress {
        app.emit("index_progress", IndexProgress { current: i + 1, total, file: file_str, status: "skip".into() })?;
      }
      continue;
    }

    if emit_progress {
      app.emit("index_progress", IndexProgress { current: i + 1, total, file: file_str.clone(), status: "extract".into() })?;
    }

    let pages = extract_text_for_document(app, &doc, settings)
      .with_context(|| format!("extract failed: {file_str}"))?;

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE file_path=?1)", params![file_str])?;
    tx.execute("DELETE FROM chunks WHERE file_path=?1", params![file_str])?;
    tx.execute(
      "INSERT OR REPLACE INTO files(path, kind, hash, size, mtime, indexed_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
      params![file_str, doc.kind.as_str(), hash, size, mtime, now_ts()]
    )?;

    let mut pending_meta: Vec<(i32, i32, Option<String>, String)> = vec![];
    let mut pending_texts: Vec<String> = vec![];

    let flush = |tx: &rusqlite::Transaction,
                 ollama: &Ollama,
                 embed_model: &str,
                 pending_meta: &mut Vec<(i32, i32, Option<String>, String)>,
                 pending_texts: &mut Vec<String>| -> Result<()> {
      if pending_texts.is_empty() { return Ok(()); }
      let embeds = ollama.embed(embed_model, pending_texts.clone())?;

      for (idx, emb) in embeds.into_iter().enumerate() {
        let (page, chunk_index, lang, text) = pending_meta[idx].clone();
        tx.execute(
          "INSERT INTO chunks(file_path, page, chunk_index, lang, text) VALUES(?1, ?2, ?3, ?4, ?5)",
          params![&file_str, page, chunk_index, lang, text]
        )?;
        let id = tx.last_insert_rowid();

        let emb_json = serde_json::to_string(&emb)?;
        tx.execute(
          "INSERT INTO vec_chunks(rowid, embedding) VALUES(?1, vec_f32(?2))",
          params![id, emb_json]
        )?;
      }

      pending_meta.clear();
      pending_texts.clear();
      Ok(())
    };

    for (pi, page_text) in pages.iter().enumerate() {
      let chunks = chunk_text(page_text, settings.chunk_size, settings.chunk_overlap);
      for (ci, ch) in chunks.into_iter().enumerate() {
        let lang = detect_lang_code(&ch);
        pending_meta.push((pi as i32, ci as i32, lang, ch.clone()));
        pending_texts.push(ch);

        if pending_texts.len() >= 16 {
          flush(&tx, &ollama, embed_model, &mut pending_meta, &mut pending_texts)?;
        }
      }
    }
    flush(&tx, &ollama, embed_model, &mut pending_meta, &mut pending_texts)?;
    tx.commit()?;

    if emit_progress {
      app.emit("index_progress", IndexProgress { current: i + 1, total, file: file_str, status: "done".into() })?;
    }
  }

  if emit_progress {
    app.emit("index_done", true)?;
  }
  Ok(())
}

pub fn index_library(app: AppHandle, targets: Vec<IndexTarget>, embed_model: String, settings: IndexSettings) -> Result<()> {
  let docs = list_documents(&targets);
  index_documents(&app, docs, &embed_model, &settings, true)
}

pub fn index_files(app: &AppHandle, files: Vec<String>, embed_model: String, settings: IndexSettings) -> Result<()> {
  let mut docs = vec![];
  for file in files {
    let path = PathBuf::from(&file);
    if let Some(kind) = kind_from_path(&path) {
      if path.is_file() {
        docs.push(DocumentCandidate { path, kind });
      }
    }
  }
  index_documents(app, docs, &embed_model, &settings, true)
}

pub fn preview_index(app: &AppHandle, targets: Vec<IndexTarget>) -> Result<Vec<IndexFilePreview>> {
  let conn = open_db(app)?;
  let indexed = load_indexed_hashes(&conn)?;
  let mut out = vec![];

  for item in list_preview_items(&targets) {
    let path_str = item.path.to_string_lossy().to_string();
    let (status, size, mtime) = if !item.exists {
      ("missing".to_string(), 0, 0)
    } else {
      let (hash, size, mtime) = file_fingerprint(&item.path)?;
      let status = match indexed.get(&path_str) {
        None => "new",
        Some(old) if old == &hash => "indexed",
        Some(_) => "changed",
      };
      (status.to_string(), size, mtime)
    };

    out.push(IndexFilePreview {
      path: path_str,
      kind: item.kind.as_str().to_string(),
      status,
      size,
      mtime,
    });
  }

  out.sort_by(|a, b| a.path.cmp(&b.path));
  Ok(out)
}

pub fn chat(app: &AppHandle, question: String, llm_model: String, embed_model: String, settings: RetrievalSettings) -> Result<ChatResult> {
  let ollama = Ollama::new();
  let conn = open_db(app)?;

  let q = ollama.embed(&embed_model, question.as_str())?;
  let q0 = q.get(0).context("No embedding returned")?;
  let q_json = serde_json::to_string(q0)?;

  let q_lang = detect_lang_code(&question);

  let mut candidate_k = settings.top_k.max(1);
  if settings.use_mmr {
    candidate_k = candidate_k.max(settings.mmr_candidates.max(1));
  }

  let mut stmt = conn.prepare(
    "WITH matches AS (
       SELECT rowid AS id, distance
       FROM vec_chunks
       WHERE embedding MATCH vec_f32(?1) AND k = ?2
       ORDER BY distance
     )
     SELECT c.file_path, c.page, c.text, c.lang, m.distance
     FROM matches m
     JOIN chunks c ON c.id = m.id
     ORDER BY m.distance;"
  )?;

  #[derive(Clone)]
  struct Candidate {
    file_path: String,
    page: i32,
    text: String,
    lang: Option<String>,
    distance: f64,
  }

  let mut rows = stmt.query(params![q_json, candidate_k])?;
  let mut candidates: Vec<Candidate> = vec![];

  while let Some(r) = rows.next()? {
    let file_path: String = r.get(0)?;
    let page: i32 = r.get(1)?;
    let text: String = r.get(2)?;
    let lang: Option<String> = r.get(3)?;
    let distance: f64 = r.get(4)?;

    if let Some(max_dist) = settings.max_distance {
      if distance > max_dist {
        continue;
      }
    }

    candidates.push(Candidate { file_path, page, text, lang, distance });
  }

  let mut filtered = if let Some(ref ql) = q_lang {
    let lang_hits: Vec<Candidate> = candidates
      .iter()
      .cloned()
      .filter(|c| c.lang.as_deref() == Some(ql.as_str()))
      .collect();
    if !lang_hits.is_empty() { lang_hits } else { candidates }
  } else {
    candidates
  };

  let top_k = settings.top_k.max(1) as usize;
  if filtered.len() > top_k && settings.use_mmr {
    let texts: Vec<String> = filtered.iter().map(|c| c.text.clone()).collect();
    let mut embeds = ollama.embed(&embed_model, texts)?;
    let lambda = settings.mmr_lambda.clamp(0.0, 1.0);

    if embeds.len() < filtered.len() {
      filtered.truncate(embeds.len());
    } else if embeds.len() > filtered.len() {
      embeds.truncate(filtered.len());
    }

    let mut selected_indices: Vec<usize> = Vec::new();
    let mut used = vec![false; filtered.len()];

    while selected_indices.len() < top_k {
      let mut best_idx: Option<usize> = None;
      let mut best_score = f64::NEG_INFINITY;

      for i in 0..filtered.len() {
        if used[i] { continue; }
        let sim_to_query = embeds.get(i).map(|e| cosine_similarity(q0, e)).unwrap_or(0.0);
        let mut max_sim_to_selected = 0.0f64;
        for sel_idx in &selected_indices {
          if let (Some(a), Some(b)) = (embeds.get(i), embeds.get(*sel_idx)) {
            let sim = cosine_similarity(a, b);
            if sim > max_sim_to_selected {
              max_sim_to_selected = sim;
            }
          }
        }

        let score = (lambda * sim_to_query) - ((1.0 - lambda) * max_sim_to_selected);
        if score > best_score {
          best_score = score;
          best_idx = Some(i);
        }
      }

      if let Some(idx) = best_idx {
        used[idx] = true;
        selected_indices.push(idx);
      } else {
        break;
      }
    }

    let mut selected: Vec<Candidate> = Vec::new();
    for idx in selected_indices {
      if let Some(c) = filtered.get(idx) {
        selected.push(c.clone());
      }
    }
    filtered = selected;
  }

  let mut sources: Vec<Source> = vec![];
  for c in filtered.into_iter().take(top_k) {
    let snippet = c.text.chars().take(600).collect::<String>();
    sources.push(Source { file_path: c.file_path, page: c.page, snippet, distance: c.distance });
  }

  let mut context_block = String::new();
  for (i, s) in sources.iter().enumerate() {
    context_block.push_str(&format!(
      "\n[SOURCE {} | {} | page {}]\n{}\n",
      i+1, s.file_path, s.page, s.snippet
    ));
  }

  let system = "Jestes asystentem RAG. Odpowiadaj tylko na podstawie podanych zrodel. Jesli w zrodlach nie ma odpowiedzi, powiedz wprost, ze nie wiesz. Odpowiadaj w jezyku pytania uzytkownika (PL/EN).";

  let user = format!(
    "Pytanie:\n{}\n\nZrodla:\n{}\n\nOdpowiedz:",
    question, context_block
  );

  let answer = ollama.chat(&llm_model, vec![
    ChatMessage { role: "system".into(), content: system.into() },
    ChatMessage { role: "user".into(), content: user },
  ])?;

  Ok(ChatResult { answer, sources })
}
