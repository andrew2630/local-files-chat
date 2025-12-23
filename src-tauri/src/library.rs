use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter};
use tauri::path::BaseDirectory;
use walkdir::WalkDir;
use whatlang::detect;
use tauri::Manager;
use rusqlite::{params, Connection, LoadExtensionGuard};

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
  pub status: String,
  pub size: i64,
  pub mtime: i64,
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

fn ensure_schema(conn: &Connection, dim: usize) -> Result<()> {
  conn.execute_batch(
    "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);

     CREATE TABLE IF NOT EXISTS files(
       path TEXT PRIMARY KEY,
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

  // sprawdź dim
  let old_dim: Option<i64> = conn.query_row(
    "SELECT value FROM meta WHERE key='embedding_dim'",
    [],
    |r| r.get::<_, String>(0)
  ).ok().and_then(|s| s.parse::<i64>().ok());

  if let Some(old) = old_dim {
    if old as usize != dim {
      // prosto: reset wektorów i chunków, gdy zmienisz model embeddingów
      conn.execute_batch(
        "DROP TABLE IF EXISTS vec_chunks;
         DELETE FROM chunks;
         DELETE FROM files;
         DELETE FROM meta WHERE key IN ('embedding_dim');"
      )?;
    }
  }

  conn.execute(
    "INSERT OR REPLACE INTO meta(key,value) VALUES('embedding_dim', ?)",
    params![dim.to_string()],
  )?;

  // vec0 virtual table (sqlite-vec) + cosine, KNN 
  conn.execute_batch(&format!(
    "CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks
     USING vec0(embedding float[{dim}] distance_metric=cosine);"
  ))?;

  Ok(())
}

fn is_pdf(p: &Path) -> bool {
  p.extension()
    .and_then(|x| x.to_str())
    .map(|s| s.eq_ignore_ascii_case("pdf"))
    .unwrap_or(false)
}

fn list_pdfs(targets: &[IndexTarget]) -> Vec<PathBuf> {
  let mut out = vec![];
  let mut seen: HashSet<String> = HashSet::new();

  for target in targets {
    let base = PathBuf::from(&target.path);
    match target.kind {
      IndexTargetKind::File => {
        if base.is_file() && is_pdf(&base) {
          let key = base.to_string_lossy().to_string();
          if seen.insert(key) {
            out.push(base);
          }
        }
      }
      IndexTargetKind::Folder => {
        if !base.is_dir() { continue; }
        let walker = if target.include_subfolders {
          WalkDir::new(&base)
        } else {
          WalkDir::new(&base).max_depth(1)
        };

        for e in walker.into_iter().filter_map(|e| e.ok()) {
          if !e.file_type().is_file() { continue; }
          let p = e.path();
          if !is_pdf(p) { continue; }
          let key = p.to_string_lossy().to_string();
          if seen.insert(key) {
            out.push(p.to_path_buf());
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
  if s.is_empty() { return vec![]; }

  let mut out = vec![];
  let mut start = 0usize;
  let bytes = s.as_bytes();

  while start < bytes.len() {
    let end = usize::min(start + max_chars, bytes.len());
    let chunk = String::from_utf8_lossy(&bytes[start..end]).trim().to_string();
    if !chunk.is_empty() { out.push(chunk); }
    if end == bytes.len() { break; }
    start = end.saturating_sub(overlap);
  }
  out
}

fn detect_lang_code(text: &str) -> Option<String> {
  detect(text).map(|i| i.lang().code().to_string())
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

pub fn index_library(app: AppHandle, targets: Vec<IndexTarget>, embed_model: String) -> Result<()> {
  let ollama = Ollama::new();

  // ustal dim embeddingów (jednym “test” embeddingiem)
  let test = ollama.embed(&embed_model, "dim probe")?;
  let dim = test.get(0).map(|v| v.len()).unwrap_or(0);
  anyhow::ensure!(dim > 0, "Embedding dim is 0 (model embed failed?)");

  let mut conn = open_db(&app)?;
  ensure_schema(&conn, dim)?;

  let pdfs = list_pdfs(&targets);
  let total = pdfs.len();
  app.emit("index_progress", IndexProgress { current: 0, total, file: "".into(), status: "start".into() })?;

  for (i, path) in pdfs.into_iter().enumerate() {
    let file_str = path.to_string_lossy().to_string();
    let (hash, size, mtime) = file_fingerprint(&path)?;

    // skip jeśli już było
    let old_hash: Option<String> = conn.query_row(
      "SELECT hash FROM files WHERE path=?1",
      params![file_str],
      |r| r.get(0)
    ).ok();

    if old_hash.as_deref() == Some(&hash) {
      app.emit("index_progress", IndexProgress { current: i+1, total, file: file_str, status: "skip".into() })?;
      continue;
    }

    app.emit("index_progress", IndexProgress { current: i+1, total, file: file_str.clone(), status: "extract".into() })?;

    // PDF → text (MVP: strony wykrywane po \x0C jeśli wystąpi)
    let raw = pdf_extract::extract_text(&path)
      .with_context(|| format!("PDF extract failed: {file_str}"))?;

    let pages: Vec<&str> = if raw.contains('\x0C') { raw.split('\x0C').collect() } else { vec![raw.as_str()] };

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE file_path=?1)", params![file_str])?;
    tx.execute("DELETE FROM chunks WHERE file_path=?1", params![file_str])?;
    tx.execute(
      "INSERT OR REPLACE INTO files(path, hash, size, mtime, indexed_at) VALUES(?1, ?2, ?3, ?4, ?5)",
      params![file_str, hash, size, mtime, now_ts()]
    )?;

    // batching embeddingów
    let mut pending_meta: Vec<(i32, i32, Option<String>, String)> = vec![]; // page, chunk_index, lang, text
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

        // emb -> JSON string, insert as float32 vector via vec_f32 
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
      let chunks = chunk_text(page_text, 1400, 250);
      for (ci, ch) in chunks.into_iter().enumerate() {
        let lang = detect_lang_code(&ch);
        pending_meta.push((pi as i32, ci as i32, lang, ch.clone()));
        pending_texts.push(ch);

        if pending_texts.len() >= 16 {
          flush(&tx, &ollama, &embed_model, &mut pending_meta, &mut pending_texts)?;
        }
      }
    }
    flush(&tx, &ollama, &embed_model, &mut pending_meta, &mut pending_texts)?;
    tx.commit()?;

    app.emit("index_progress", IndexProgress { current: i+1, total, file: file_str, status: "done".into() })?;
  }

  app.emit("index_done", true)?;
  Ok(())
}

pub fn preview_index(app: &AppHandle, targets: Vec<IndexTarget>) -> Result<Vec<IndexFilePreview>> {
  let conn = open_db(app)?;
  let indexed = load_indexed_hashes(&conn)?;
  let mut out = vec![];

  for path in list_pdfs(&targets) {
    let path_str = path.to_string_lossy().to_string();
    let (hash, size, mtime) = file_fingerprint(&path)?;
    let status = match indexed.get(&path_str) {
      None => "new",
      Some(old) if old == &hash => "indexed",
      Some(_) => "changed",
    };
    out.push(IndexFilePreview {
      path: path_str,
      status: status.to_string(),
      size,
      mtime,
    });
  }

  out.sort_by(|a, b| a.path.cmp(&b.path));
  Ok(out)
}

pub fn chat(app: &AppHandle, question: String, llm_model: String, embed_model: String, top_k: i64) -> Result<ChatResult> {
  let ollama = Ollama::new();
  let conn = open_db(app)?;

  // embed pytania
  let q = ollama.embed(&embed_model, question.as_str())?;
  let q0 = q.get(0).context("No embedding returned")?;
  let q_json = serde_json::to_string(q0)?;

  let q_lang = detect_lang_code(&question);

  // KNN query vec0 (CTE + JOIN do chunks) 
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

  let mut rows = stmt.query(params![q_json, top_k])?;
  let mut sources: Vec<Source> = vec![];

  while let Some(r) = rows.next()? {
    let file_path: String = r.get(0)?;
    let page: i32 = r.get(1)?;
    let text: String = r.get(2)?;
    let lang: Option<String> = r.get(3)?;
    let distance: f64 = r.get(4)?;

    // prosta preferencja języka: jeśli wykryliśmy język pytania, odfiltrowuj inne (MVP)
    if let (Some(q), Some(l)) = (&q_lang, &lang) {
      if q != l { continue; }
    }

    let snippet = text.chars().take(600).collect::<String>();
    sources.push(Source { file_path, page, snippet, distance });

    if sources.len() >= 8 { break; }
  }

  let mut context_block = String::new();
  for (i, s) in sources.iter().enumerate() {
    context_block.push_str(&format!(
      "\n[SOURCE {} | {} | page {}]\n{}\n",
      i+1, s.file_path, s.page, s.snippet
    ));
  }

  let system = "Jestes asystentem RAG. Odpowiadaj tylko na podstawie podanych zrodel. \
Jesli w zrodlach nie ma odpowiedzi, powiedz wprost, ze nie wiesz. \
Odpowiadaj w jezyku pytania uzytkownika (PL/EN).";

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
