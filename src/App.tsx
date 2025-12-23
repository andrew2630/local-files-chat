import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import "./App.css";

type SourceHit = { file_path: string; page: number; snippet: string; distance: number };
type ChatResponse = { answer: string; sources: SourceHit[] };
type IndexProgress = { current: number; total: number; file: string; status: string };

type IndexTarget = {
  id: string;
  path: string;
  kind: "file" | "folder";
  includeSubfolders: boolean;
};

type IndexFilePreview = {
  path: string;
  status: "new" | "indexed" | "changed" | string;
  size: number;
  mtime: number;
};

type Lang = "pl" | "en";
type Theme = "system" | "light" | "dark";

const copy = {
  pl: {
    appTitle: "Local Files Chat",
    appSubtitle: "Rozmawiaj z lokalnymi dokumentami (RAG)",
    language: "Język",
    theme: "Motyw",
    themeSystem: "System",
    themeLight: "Jasny",
    themeDark: "Ciemny",
    sourcesTitle: "Źródła",
    addFolders: "+ Dodaj foldery",
    addFiles: "+ Dodaj pliki",
    includeSubfolders: "Uwzględnij podfoldery",
    folderLabel: "Folder",
    fileLabel: "Plik PDF",
    targetsEmpty: "Brak dodanych źródeł. Dodaj foldery lub pliki PDF.",
    indexNow: "Indeksuj teraz",
    indexing: "Indeksowanie...",
    indexIdle: "Bezczynny",
    indexDone: "Indeks zakończony.",
    indexError: "Błąd indeksowania",
    modelsTitle: "Modele",
    refreshModels: "Odśwież listę",
    chatModel: "Model czatu",
    embedModel: "Model embeddingów",
    modelsEmpty: "Nie znaleziono modeli w Ollama.",
    modelsError: "Nie można pobrać modeli z Ollama.",
    retrievalTitle: "Ustawienia wyszukiwania",
    topK: "Top K",
    filesTitle: "Pliki do indeksu",
    filesSummary: "Wykryto",
    filesNew: "Nowe",
    filesIndexed: "Zaindeksowane",
    filesChanged: "Do aktualizacji",
    filesEmpty: "Brak plików PDF w wybranych źródłach.",
    filterFiles: "Filtruj listę plików...",
    chatTitle: "Czat",
    askPlaceholder: "Zadaj pytanie o dokumenty...",
    send: "Wyślij",
    you: "Ty",
    assistant: "Asystent",
    sourcesLabel: "Źródła",
    openFile: "Otwórz",
    reveal: "Pokaż w folderze",
    status: "Status",
    progress: "Postęp",
    modelHint: "Modele są pobierane z lokalnej instancji Ollama.",
    indexStatus: {
      start: "Start",
      skip: "Pominięto",
      extract: "Ekstrakcja",
      done: "Gotowe",
    },
    fileStatus: {
      new: "Nowe",
      indexed: "Zaindeksowane",
      changed: "Do aktualizacji",
    },
  },
  en: {
    appTitle: "Local Files Chat",
    appSubtitle: "Chat with your local documents (RAG)",
    language: "Language",
    theme: "Theme",
    themeSystem: "System",
    themeLight: "Light",
    themeDark: "Dark",
    sourcesTitle: "Sources",
    addFolders: "+ Add folders",
    addFiles: "+ Add files",
    includeSubfolders: "Include subfolders",
    folderLabel: "Folder",
    fileLabel: "PDF file",
    targetsEmpty: "No sources yet. Add folders or PDF files.",
    indexNow: "Index now",
    indexing: "Indexing...",
    indexIdle: "Idle",
    indexDone: "Index complete.",
    indexError: "Index error",
    modelsTitle: "Models",
    refreshModels: "Refresh list",
    chatModel: "Chat model",
    embedModel: "Embedding model",
    modelsEmpty: "No models found in Ollama.",
    modelsError: "Cannot load models from Ollama.",
    retrievalTitle: "Retrieval settings",
    topK: "Top K",
    filesTitle: "Files to index",
    filesSummary: "Found",
    filesNew: "New",
    filesIndexed: "Indexed",
    filesChanged: "Needs update",
    filesEmpty: "No PDF files in selected sources.",
    filterFiles: "Filter files...",
    chatTitle: "Chat",
    askPlaceholder: "Ask a question about your documents...",
    send: "Send",
    you: "You",
    assistant: "Assistant",
    sourcesLabel: "Sources",
    openFile: "Open",
    reveal: "Reveal in folder",
    status: "Status",
    progress: "Progress",
    modelHint: "Models are fetched from your local Ollama instance.",
    indexStatus: {
      start: "Start",
      skip: "Skipped",
      extract: "Extracting",
      done: "Done",
    },
    fileStatus: {
      new: "New",
      indexed: "Indexed",
      changed: "Needs update",
    },
  },
} as const;

const EMBED_HINTS = ["embed", "embedding", "bge", "e5", "nomic-embed", "gte", "instructor"];

function isEmbeddingModel(name: string) {
  const lower = name.toLowerCase();
  return EMBED_HINTS.some((hint) => lower.includes(hint));
}

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function App() {
  const [lang, setLang] = useState<Lang>(() => {
    const saved = localStorage.getItem("ui.lang");
    if (saved === "pl" || saved === "en") return saved;
    return navigator.language.toLowerCase().startsWith("pl") ? "pl" : "en";
  });
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("ui.theme");
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
    return "system";
  });

  const [targets, setTargets] = useState<IndexTarget[]>([]);
  const [previewFiles, setPreviewFiles] = useState<IndexFilePreview[]>([]);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewFilter, setPreviewFilter] = useState("");
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null);
  const [indexDone, setIndexDone] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);

  const [models, setModels] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [chatModel, setChatModel] = useState("");
  const [embedModel, setEmbedModel] = useState("");
  const [chatTouched, setChatTouched] = useState(false);
  const [embedTouched, setEmbedTouched] = useState(false);

  const [topK, setTopK] = useState(8);
  const [q, setQ] = useState("");
  const [log, setLog] = useState<{ role: "user" | "assistant"; text: string; sources?: SourceHit[] }[]>([]);
  const [chatBusy, setChatBusy] = useState(false);

  const t = copy[lang];

  useEffect(() => {
    localStorage.setItem("ui.lang", lang);
  }, [lang]);

  useEffect(() => {
    localStorage.setItem("ui.theme", theme);
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }, [theme]);

  async function loadModels() {
    setModelsBusy(true);
    setModelError(null);
    try {
      const res = (await invoke("list_models")) as string[];
      setModels(res);

      const embedCandidates = res.filter(isEmbeddingModel);
      const chatCandidates = res.filter((m) => !isEmbeddingModel(m));

      if (!chatTouched && !chatModel) {
        setChatModel(chatCandidates[0] ?? res[0] ?? "");
      }
      if (!embedTouched && !embedModel) {
        setEmbedModel(embedCandidates[0] ?? res[0] ?? "");
      }
    } catch (err) {
      setModelError(String(err));
    } finally {
      setModelsBusy(false);
    }
  }

  useEffect(() => {
    loadModels();
  }, []);

  useEffect(() => {
    let unlistenProgress: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;

    listen<IndexProgress>("index_progress", (event) => {
      setIndexProgress(event.payload);
      setIndexDone(false);
      setIndexError(null);
      setIndexing(true);
    }).then((unlisten) => {
      unlistenProgress = unlisten;
    });

    listen<boolean>("index_done", () => {
      setIndexDone(true);
      setIndexProgress(null);
      setIndexing(false);
      setPreviewVersion((v) => v + 1);
    }).then((unlisten) => {
      unlistenDone = unlisten;
    });

    listen<string>("index_error", (event) => {
      setIndexError(event.payload);
      setIndexProgress(null);
      setIndexing(false);
    }).then((unlisten) => {
      unlistenError = unlisten;
    });

    return () => {
      unlistenProgress?.();
      unlistenDone?.();
      unlistenError?.();
    };
  }, []);

  useEffect(() => {
    if (targets.length === 0) {
      setPreviewFiles([]);
      setPreviewBusy(false);
      setIndexDone(false);
      return;
    }

    setIndexDone(false);

    let active = true;
    const timer = setTimeout(async () => {
      setPreviewBusy(true);
      try {
        const payload = targets.map(({ path, kind, includeSubfolders }) => ({
          path,
          kind,
          includeSubfolders,
        }));
        const res = (await invoke("preview_index", { targets: payload })) as IndexFilePreview[];
        if (active) {
          setPreviewFiles(res);
        }
      } catch (err) {
        if (active) {
          setIndexError(String(err));
        }
      } finally {
        if (active) {
          setPreviewBusy(false);
        }
      }
    }, 250);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [targets, previewVersion]);

  const filteredFiles = useMemo(() => {
    if (!previewFilter.trim()) return previewFiles;
    const q = previewFilter.trim().toLowerCase();
    return previewFiles.filter((f) => f.path.toLowerCase().includes(q));
  }, [previewFiles, previewFilter]);

  const fileCounts = useMemo(() => {
    return previewFiles.reduce(
      (acc, f) => {
        acc.total += 1;
        if (f.status === "indexed") acc.indexed += 1;
        else if (f.status === "changed") acc.changed += 1;
        else acc.new += 1;
        return acc;
      },
      { total: 0, indexed: 0, changed: 0, new: 0 },
    );
  }, [previewFiles]);

  async function addFolders() {
    const res = await open({ directory: true, multiple: true });
    if (!res) return;
    const items = Array.isArray(res) ? res : [res];
    setTargets((prev) => {
      const next = [...prev];
      for (const path of items) {
        if (next.some((t) => t.path === path && t.kind === "folder")) continue;
        next.push({ id: newId(), path, kind: "folder", includeSubfolders: true });
      }
      return next;
    });
  }

  async function addFiles() {
    const res = await open({
      multiple: true,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!res) return;
    const items = Array.isArray(res) ? res : [res];
    setTargets((prev) => {
      const next = [...prev];
      for (const path of items) {
        if (next.some((t) => t.path === path && t.kind === "file")) continue;
        next.push({ id: newId(), path, kind: "file", includeSubfolders: false });
      }
      return next;
    });
  }

  function removeTarget(id: string) {
    setTargets((prev) => prev.filter((t) => t.id !== id));
  }

  function toggleSubfolders(id: string, value: boolean) {
    setTargets((prev) =>
      prev.map((t) => (t.id === id ? { ...t, includeSubfolders: value } : t)),
    );
  }

  async function doIndex() {
    if (!embedModel || targets.length === 0) return;
    setIndexError(null);
    setIndexDone(false);
    setIndexing(true);
    try {
      const payload = targets.map(({ path, kind, includeSubfolders }) => ({
        path,
        kind,
        includeSubfolders,
      }));
      await invoke("start_index", { targets: payload, embed_model: embedModel });
    } catch (err) {
      setIndexError(String(err));
      setIndexing(false);
    }
  }

  async function send() {
    const query = q.trim();
    if (!query || !chatModel || !embedModel) return;
    setQ("");
    setLog((l) => [...l, { role: "user", text: query }]);
    setChatBusy(true);
    try {
      const resp = (await invoke("chat", {
        question: query,
        llm_model: chatModel,
        embed_model: embedModel,
        top_k: topK,
      })) as ChatResponse;
      setLog((l) => [...l, { role: "assistant", text: resp.answer, sources: resp.sources }]);
    } finally {
      setChatBusy(false);
    }
  }

  const embedOptions = models.filter(isEmbeddingModel);
  const embedList = embedOptions.length > 0 ? embedOptions : models;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-title">{t.appTitle}</div>
          <div className="brand-subtitle">{t.appSubtitle}</div>
        </div>
        <div className="topbar-controls">
          <label className="select-field">
            <span>{t.language}</span>
            <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
              <option value="pl">PL</option>
              <option value="en">EN</option>
            </select>
          </label>
          <label className="select-field">
            <span>{t.theme}</span>
            <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
              <option value="system">{t.themeSystem}</option>
              <option value="light">{t.themeLight}</option>
              <option value="dark">{t.themeDark}</option>
            </select>
          </label>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <section className="card">
            <div className="card-header">
              <h2>{t.sourcesTitle}</h2>
              <div className="card-actions">
                <button className="ghost" onClick={addFolders}>{t.addFolders}</button>
                <button className="ghost" onClick={addFiles}>{t.addFiles}</button>
              </div>
            </div>
            {targets.length === 0 && <div className="empty">{t.targetsEmpty}</div>}
            {targets.length > 0 && (
              <div className="target-list">
                {targets.map((tgt) => (
                  <div className="target-row" key={tgt.id}>
                    <div className="target-main">
                      <div className="target-kind">{tgt.kind === "folder" ? t.folderLabel : t.fileLabel}</div>
                      <div className="target-path">{tgt.path}</div>
                      {tgt.kind === "folder" && (
                        <label className="toggle">
                          <input
                            type="checkbox"
                            checked={tgt.includeSubfolders}
                            onChange={(e) => toggleSubfolders(tgt.id, e.target.checked)}
                          />
                          <span>{t.includeSubfolders}</span>
                        </label>
                      )}
                    </div>
                    <button className="ghost small" onClick={() => removeTarget(tgt.id)}>x</button>
                  </div>
                ))}
              </div>
            )}
            <div className="card-footer">
              <button className="primary" onClick={doIndex} disabled={indexing || targets.length === 0 || !embedModel}>
                {indexing ? t.indexing : t.indexNow}
              </button>
            </div>
          </section>

          <section className="card">
            <div className="card-header">
              <h2>{t.filesTitle}</h2>
              <div className="meta">
                {t.filesSummary}: {fileCounts.total} | {t.filesNew}: {fileCounts.new} | {t.filesIndexed}: {fileCounts.indexed} | {t.filesChanged}: {fileCounts.changed}
              </div>
            </div>
            <input
              className="filter"
              value={previewFilter}
              onChange={(e) => setPreviewFilter(e.target.value)}
              placeholder={t.filterFiles}
              disabled={previewFiles.length === 0}
            />
            {previewBusy && <div className="hint">{t.indexing}</div>}
            {!previewBusy && filteredFiles.length === 0 && (
              <div className="empty">{t.filesEmpty}</div>
            )}
            <div className="file-list">
              {filteredFiles.map((file) => {
                const statusLabel = t.fileStatus[file.status as keyof typeof t.fileStatus] ?? file.status;
                const badgeClass =
                  file.status === "indexed" ? "badge good" : file.status === "changed" ? "badge warn" : "badge neutral";
                return (
                  <div className="file-row" key={file.path}>
                    <div className="file-main">
                      <div className="file-path">{file.path}</div>
                      <div className="file-meta">{formatSize(file.size)}</div>
                    </div>
                    <span className={badgeClass}>{statusLabel}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card">
            <div className="card-header">
              <h2>{t.modelsTitle}</h2>
              <button className="ghost small" onClick={loadModels} disabled={modelsBusy}>
                {t.refreshModels}
              </button>
            </div>
            <div className="hint">{t.modelHint}</div>
            <div className="field">
              <label>{t.chatModel}</label>
              <input
                list="chat-models"
                value={chatModel}
                onChange={(e) => {
                  setChatModel(e.target.value);
                  setChatTouched(true);
                }}
                placeholder="llama3.1:8b"
              />
              <datalist id="chat-models">
                {models.map((m) => (
                  <option value={m} key={m} />
                ))}
              </datalist>
            </div>
            <div className="field">
              <label>{t.embedModel}</label>
              <input
                list="embed-models"
                value={embedModel}
                onChange={(e) => {
                  setEmbedModel(e.target.value);
                  setEmbedTouched(true);
                }}
                placeholder="nomic-embed-text"
              />
              <datalist id="embed-models">
                {embedList.map((m) => (
                  <option value={m} key={m} />
                ))}
              </datalist>
            </div>
            {modelError && <div className="error">{t.modelsError}: {modelError}</div>}
            {!modelError && models.length === 0 && !modelsBusy && <div className="empty">{t.modelsEmpty}</div>}
          </section>

          <section className="card">
            <div className="card-header">
              <h2>{t.retrievalTitle}</h2>
            </div>
            <div className="field inline">
              <label>{t.topK}</label>
              <input
                type="number"
                min={1}
                max={20}
                value={topK}
                onChange={(e) => setTopK(Number(e.target.value))}
              />
            </div>
            <div className="status">
              <div className="status-label">{t.progress}</div>
              {indexProgress && (
                <div className="status-row">
                  <span className="badge neutral">
                    {t.indexStatus[indexProgress.status as keyof typeof t.indexStatus] ?? indexProgress.status}
                  </span>
                  <span>{indexProgress.current}/{indexProgress.total}</span>
                </div>
              )}
              {!indexProgress && indexDone && <div className="hint">{t.indexDone}</div>}
              {!indexProgress && !indexDone && !indexing && <div className="hint">{t.indexIdle}</div>}
              {indexError && (
                <div className="error">
                  {t.indexError}: {indexError}
                </div>
              )}
              {indexProgress?.file && <div className="file-path">{indexProgress.file}</div>}
            </div>
          </section>
        </aside>

        <section className="chat card">
          <div className="card-header">
            <h2>{t.chatTitle}</h2>
            <div className="meta">
              {chatModel || "-"} | {embedModel || "-"}
            </div>
          </div>
          <div className="chat-log">
            {log.length === 0 && (
              <div className="empty">
                {lang === "pl"
                  ? "Zacznij rozmowę, aby zobaczyć odpowiedzi z dokumentów."
                  : "Start a conversation to see answers from your documents."}
              </div>
            )}
            {log.map((m, i) => (
              <div className={`message ${m.role}`} key={i}>
                <div className="message-role">{m.role === "user" ? t.you : t.assistant}</div>
                <div className="message-text">{m.text}</div>
                {m.sources && m.sources.length > 0 && (
                  <div className="sources">
                    <div className="sources-title">{t.sourcesLabel}</div>
                    {m.sources.map((s, idx) => (
                      <div className="source-card" key={`${s.file_path}-${idx}`}>
                        <div className="source-meta">
                          <span className="badge neutral">#{idx + 1}</span>
                          <span className="source-path">{s.file_path}</span>
                          <span className="source-score">p. {s.page + 1} | {s.distance.toFixed(4)}</span>
                        </div>
                        <div className="source-snippet">{s.snippet}</div>
                        <div className="source-actions">
                          <button className="ghost small" onClick={() => openPath(s.file_path)}>
                            {t.openFile}
                          </button>
                          <button className="ghost small" onClick={() => revealItemInDir(s.file_path)}>
                            {t.reveal}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="composer">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
              placeholder={t.askPlaceholder}
              disabled={chatBusy}
            />
            <button className="primary" onClick={send} disabled={chatBusy || !chatModel || !embedModel}>
              {t.send}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
