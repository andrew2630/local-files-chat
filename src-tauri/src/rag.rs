use anyhow::{anyhow, Context, Result};
use pdf_extract::extract_text_by_pages;
use reqwest::Client;
use rusqlite::{params, Connection, OpenFlags};
use rusqlite::LoadExtensionGuard;
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};
use walkdir::WalkDir;

use crate::{ChatResponse, SourceHit};

fn app_db_path() -> Result<PathBuf> {
  let mut dir = dirs::data_local_dir().ok_or_else(|| anyhow!("no local data dir"))?;
  dir.push("LocalFilesChat");
  fs::create_dir_all(&dir)?;
  dir.push("library.db");
  Ok(dir)
}

fn sqlite_vec_dll_path() -> Result<PathBuf> {
  // DEV: uruchamiasz z projektu → prościej
  // BUILD: plik będzie w resources (tu na start zakładamy, że w runtime skopiujesz do app dir lub użyjesz resource_dir)
  // MVP: trzymaj DLL obok DB, kopiuj przy starcie index()
  let mut dir = dirs::data_local_dir().ok_or_else(|| anyhow!("no local data dir"))?;
  dir.push("LocalFilesChat");
  fs::create_dir_all(&dir)?;
  dir.push("sqlite_vec0.dll");
  Ok(dir)
}

fn open_db(db_path: &Path, vec_dll: &Path) -> Result<Connection> {
  let conn = Connection::open_with_flags(
    db_path,
    OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
  )?;

  conn.execute_batch(
    r#"
    pragma journal_mode = wal;

    create table if not exists meta(key text primary key, value text);

    create table if not exists documents(
      id integer primary key,
      path text not null unique,
      mtime integer not null,
      size integer not null
    );

    create table if not exists chunks(
      id integer primary key,
      doc_id integer not null,
      page integer not null,
      chunk_index integer not null,
      text text not null,
      foreign key(doc_id) references documents(id) on delete cascade
    );

    create virtual table if not exists chunks_fts using fts5(text, content='chunks', content_rowid='id');
    "#,
  )?;

  // załaduj sqlite-vec
  unsafe {
    let _guard = LoadExtensionGuard::new(&conn)?;
    conn.load_extension(vec_dll, None)?;
  }

  Ok(conn)
}

async fn ollama_embed(client: &Client, base: &str, model: &str, input: &str) -> Result<Vec<f32>> {
  #[derive(Serialize)]
  struct Req<'a> { model: &'a str, input: &'a str }
  #[derive(Deserialize)]
  struct Resp { embeddings: Vec<Vec<f32>> } // /api/embed zwykle zwraca listę

  let url = format!("{}/api/embed", base.trim_end_matches('/'));
  let resp = client.post(url).json(&Req { model, input }).send().await?;
  let status = resp.status();
  if !status.is_success() {
    return Err(anyhow!("ollama embed failed: {}", status));
  }
  let data: Resp = resp.json().await?;
  data.embeddings.into_iter().next().ok_or_else(|| anyhow!("no embedding returned"))
}

async fn ollama_chat(client: &Client, base: &str, model: &str, prompt: &str) -> Result<String> {
  #[derive(Serialize)]
  struct Req<'a> {
    model: &'a str,
    messages: Vec<Message<'a>>,
    stream: bool,
  }
  #[derive(Serialize)]
  struct Message<'a> { role: &'a str, content: &'a str }

  #[derive(Deserialize)]
  struct Resp { message: RespMsg }
  #[derive(Deserialize)]
  struct RespMsg { content: String }

  let url = format!("{}/api/chat", base.trim_end_matches('/'));
  let req = Req {
    model,
    stream: false,
    messages: vec![
      Message{ role: "system", content: "Odpowiadaj w języku użytkownika (PL/EN). Cytuj źródła jako [1], [2] itd. Nie zmyślaj." },
      Message{ role: "user", content: prompt },
    ],
  };

  let resp = client.post(url).json(&req).send().await?;
  let status = resp.status();
  if !status.is_success() {
    return Err(anyhow!("ollama chat failed: {}", status));
  }
  let data: Resp = resp.json().await?;
  Ok(data.message.content)
}

fn find_pdfs(roots: &[String]) -> Vec<PathBuf> {
  let mut out = vec![];
  for r in roots {
    for e in WalkDir::new(r).into_iter().filter_map(|e| e.ok()) {
      if e.file_type().is_file() {
        let p = e.path();
        if p.extension().map(|x| x.to_string_lossy().to_lowercase()) == Some("pdf".into()) {
          out.push(p.to_path_buf());
        }
      }
    }
  }
  out
}

pub async fn index(roots: Vec<String>, embed_model: String) -> Result<()> {
  let db_path = app_db_path()?;

  // skopiuj sqlite_vec0.dll do app data (raz)
  let vec_target = sqlite_vec_dll_path()?;
  if !vec_target.exists() {
    // DLL masz w src-tauri/resources; w DEV skopiuj ręcznie do %LOCALAPPDATA%\LocalFilesChat\sqlite_vec0.dll
    return Err(anyhow!("Brak sqlite_vec0.dll w {}", vec_target.display()));
  }

  let conn = open_db(&db_path, &vec_target)?;

  let base = "http://localhost:11434";
  let client = Client::new();

  // ustal wymiar embeddingu (i utwórz vec0 jeśli nie istnieje)
  let dim = ollama_embed(&client, base, &embed_model, "dimension probe").await?.len();
  conn.execute("insert or replace into meta(key,value) values('embed_dim', ?1)", params![dim.to_string()])?;

  let create_vec = format!(
    "create virtual table if not exists vec_chunks using vec0(chunk_id integer primary key, embedding float[{}] distance_metric=cosine);",
    dim
  );
  conn.execute_batch(&create_vec)?;

  for pdf in find_pdfs(&roots) {
    let meta = fs::metadata(&pdf)?;
    let mtime = meta.modified()?.duration_since(std::time::UNIX_EPOCH)?.as_secs() as i64;
    let size = meta.len() as i64;
    let path_str = pdf.to_string_lossy().to_string();

    let mut stmt = conn.prepare("select id, mtime, size from documents where path=?1")?;
    let existing: Option<(i64,i64,i64)> = stmt.query_row(params![&path_str], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;

    if let Some((doc_id, old_mtime, old_size)) = existing {
      if old_mtime == mtime && old_size == size {
        continue; // bez zmian
      }
      conn.execute("delete from chunks where doc_id=?1", params![doc_id])?;
      conn.execute("delete from documents where id=?1", params![doc_id])?;
    }

    conn.execute("insert into documents(path,mtime,size) values(?1,?2,?3)", params![&path_str, mtime, size])?;
    let doc_id = conn.last_insert_rowid();

    let pages = extract_text_by_pages(&pdf).with_context(|| format!("pdf_extract failed: {}", path_str))?;

    for (page_idx, page_text) in pages.into_iter().enumerate() {
      let page = (page_idx + 1) as i32;
      let cleaned = page_text.replace('\u{0}', " ").trim().to_string();
      if cleaned.len() < 20 { continue; }

      // proste chunkowanie: co ~2000 znaków
      let mut chunk_index = 0i32;
      for chunk in cleaned.as_bytes().chunks(2000) {
        let text = String::from_utf8_lossy(chunk).to_string();

        conn.execute(
          "insert into chunks(doc_id,page,chunk_index,text) values(?1,?2,?3,?4)",
          params![doc_id, page, chunk_index, &text],
        )?;
        let chunk_id = conn.last_insert_rowid();

        // FTS sync
        conn.execute("insert into chunks_fts(rowid,text) values(?1,?2)", params![chunk_id, &text])?;

        // embedding → JSON → vec_f32()
        let emb = ollama_embed(&client, base, &embed_model, &text).await?;
        let emb_json = serde_json::to_string(&emb)?;
        conn.execute(
          "insert into vec_chunks(chunk_id, embedding) values(?1, vec_f32(?2))",
          params![chunk_id, emb_json],
        )?;

        chunk_index += 1;
      }
    }
  }

  Ok(())
}

pub async fn chat(query: String, roots: Vec<String>, chat_model: String, embed_model: String) -> Result<ChatResponse> {
  let db_path = app_db_path()?;
  let vec_dll = sqlite_vec_dll_path()?;
  let conn = open_db(&db_path, &vec_dll)?;

  let base = "http://localhost:11434";
  let client = Client::new();

  let q_emb = ollama_embed(&client, base, &embed_model, &query).await?;
  let q_json = serde_json::to_string(&q_emb)?;

  // KNN przez sqlite-vec (vec0)
  let mut stmt = conn.prepare(
    r#"
    with knn as (
      select chunk_id, distance
      from vec_chunks
      where embedding match vec_f32(?1)
      and k = 8
    )
    select d.path, c.page, substr(c.text,1,400) as snippet, knn.distance
    from knn
    join chunks c on c.id = knn.chunk_id
    join documents d on d.id = c.doc_id
    order by knn.distance asc
    "#
  )?;

  let mut sources: Vec<SourceHit> = vec![];
  let rows = stmt.query_map(params![q_json], |r| {
    Ok(SourceHit {
      path: r.get(0)?,
      page: r.get(1)?,
      snippet: r.get::<_, String>(2)?,
      score: r.get::<_, f32>(3)?,
    })
  })?;

  for r in rows { sources.push(r?); }

  let mut context = String::new();
  for (i, s) in sources.iter().enumerate() {
    context.push_str(&format!("[{}] FILE: {}\nPAGE: {}\n{}\n\n", i+1, s.path, s.page, s.snippet));
  }

  let prompt = format!(
    "Pytanie: {}\n\nKontekst z dokumentów:\n{}\nOdpowiedz krótko i konkretnie, cytując [1],[2] itd.",
    query, context
  );

  let answer = ollama_chat(&client, base, &chat_model, &prompt).await?;
  Ok(ChatResponse { answer, sources })
}
