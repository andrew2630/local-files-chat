import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import "./App.css";

type SourceHit = { file_path: string; page: number; snippet: string; distance: number };
type ChatResponse = { answer: string; sources: SourceHit[] };
type IndexProgress = { current: number; total: number; file: string; status: string };
type SetupStatus = { running: boolean; models: string[]; defaultChat: string; defaultEmbed: string };
type SetupProgress = { stage: string; message: string };
type ModelPullProgress = { model: string; line: string };
type WatcherStatus = { status: string; watched: number };
type ReindexProgress = { status: string; files: string[] };
type SetupState = "checking" | "needs" | "running" | "ready";

type IndexTarget = {
  id: string;
  path: string;
  kind: "file" | "folder";
  includeSubfolders: boolean;
};

type IndexFilePreview = {
  path: string;
  kind: string;
  status: "new" | "indexed" | "changed" | "missing" | string;
  size: number;
  mtime: number;
};

type IndexSettings = {
  chunkSize: number;
  chunkOverlap: number;
  ocrEnabled: boolean;
  ocrLang: string;
  ocrMinChars: number;
  ocrDpi: number;
};

type RetrievalSettings = {
  topK: number;
  maxDistance: number | null;
  useMmr: boolean;
  mmrLambda: number;
  mmrCandidates: number;
};

type ChatMessage = { role: "user" | "assistant"; text: string; sources?: SourceHit[] };
type ChatSession = { id: string; title: string; createdAt: number; messages: ChatMessage[] };

type Lang = "pl" | "en";
type Theme = "system" | "light" | "dark";

const DEFAULT_INDEX_SETTINGS: IndexSettings = {
  chunkSize: 1400,
  chunkOverlap: 250,
  ocrEnabled: true,
  ocrLang: "pol+eng",
  ocrMinChars: 120,
  ocrDpi: 300,
};

const DEFAULT_RETRIEVAL_SETTINGS: RetrievalSettings = {
  topK: 8,
  maxDistance: null,
  useMmr: true,
  mmrLambda: 0.7,
  mmrCandidates: 24,
};

const STORAGE_KEYS = {
  lang: "ui.lang",
  theme: "ui.theme",
  indexSettings: "ui.indexSettings",
  retrievalSettings: "ui.retrievalSettings",
  sessions: "chat.sessions",
  activeSession: "chat.activeSessionId",
  setupComplete: "setup.complete",
};

const copy = {
  pl: {
    appTitle: "Local Files Chat",
    appSubtitle: "Rozmawiaj z lokalnymi dokumentami (RAG)",
    setupTitle: "Konfiguracja / Zależności",
    setupSubtitle: "Aplikacja wymaga lokalnej instancji Ollama i domyślnych modeli.",
    setupChecking: "Sprawdzanie zależności...",
    setupRunning: "Pobieranie modeli...",
    setupReady: "Gotowe",
    setupError: "Błąd konfiguracji",
    setupHint: "Po instalacji Ollama kliknij „Spróbuj ponownie”.",
    installOllama: "Zainstaluj Ollama",
    retry: "Spróbuj ponownie",
    requiredModels: "Wymagane modele",
    missingModels: "Brakujące modele",
    reRunSetup: "Uruchom ponownie setup",
    ollamaNotRunning: "Ollama nie jest uruchomiona.",
    setupLogs: "Logi instalacji",
    watcherStatus: "Watcher",
    watcherWatching: "Monitor aktywny",
    reindexStatus: "Auto-reindeksacja",
    reindexQueued: "W kolejce",
    reindexDone: "Zakończono",
    reindexError: "Błąd",
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
    fileLabel: "Plik",
    targetsEmpty: "Brak dodanych źródeł. Dodaj foldery lub pliki.",
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
    filesMissing: "Brak pliku",
    filesEmpty: "Brak plików w wybranych źródłach.",
    filterFiles: "Filtruj listę plików...",
    refreshFile: "Odśwież",
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
    advancedTitle: "Ustawienia zaawansowane",
    advancedToggle: "Pokaż ustawienia",
    chunkSize: "Rozmiar chunków",
    chunkOverlap: "Nakładanie chunków",
    ocrEnabled: "OCR dla skanów PDF",
    ocrLang: "Język OCR",
    ocrMinChars: "Min. znaków przed OCR",
    ocrDpi: "DPI dla OCR",
    useMmr: "MMR (różnorodność źródeł)",
    mmrLambda: "MMR lambda",
    mmrCandidates: "Liczba kandydatów MMR",
    maxDistance: "Maks. dystans",
    historyTitle: "Historia rozmów",
    newChat: "Nowa rozmowa",
    loadChat: "Wczytaj",
    deleteChat: "Usuń",
    emptyChat: "Zacznij rozmowę, aby zobaczyć odpowiedzi z dokumentów.",
    indexStatus: {
      start: "Start",
      skip: "Pominięto",
      extract: "Ekstrakcja",
      done: "Gotowe",
      missing: "Brak pliku",
    },
    fileStatus: {
      new: "Nowe",
      indexed: "Zaindeksowane",
      changed: "Do aktualizacji",
      missing: "Brak pliku",
    },
  },
  en: {
    appTitle: "Local Files Chat",
    appSubtitle: "Chat with your local documents (RAG)",
    setupTitle: "Setup / Dependencies",
    setupSubtitle: "The app needs a local Ollama instance and default models.",
    setupChecking: "Checking dependencies...",
    setupRunning: "Downloading models...",
    setupReady: "Ready",
    setupError: "Setup error",
    setupHint: "After installing Ollama, click Retry.",
    installOllama: "Install Ollama",
    retry: "Retry",
    requiredModels: "Required models",
    missingModels: "Missing models",
    reRunSetup: "Re-run setup",
    ollamaNotRunning: "Ollama is not running.",
    setupLogs: "Setup logs",
    watcherStatus: "Watcher",
    watcherWatching: "Watching",
    reindexStatus: "Auto reindex",
    reindexQueued: "Queued",
    reindexDone: "Done",
    reindexError: "Error",
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
    fileLabel: "File",
    targetsEmpty: "No sources yet. Add folders or files.",
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
    filesMissing: "Missing",
    filesEmpty: "No files in selected sources.",
    filterFiles: "Filter files...",
    refreshFile: "Refresh",
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
    advancedTitle: "Advanced settings",
    advancedToggle: "Show settings",
    chunkSize: "Chunk size",
    chunkOverlap: "Chunk overlap",
    ocrEnabled: "OCR for scanned PDFs",
    ocrLang: "OCR language",
    ocrMinChars: "Min chars before OCR",
    ocrDpi: "OCR DPI",
    useMmr: "MMR (source diversity)",
    mmrLambda: "MMR lambda",
    mmrCandidates: "MMR candidates",
    maxDistance: "Max distance",
    historyTitle: "Chat history",
    newChat: "New chat",
    loadChat: "Load",
    deleteChat: "Delete",
    emptyChat: "Start a conversation to see answers from your documents.",
    indexStatus: {
      start: "Start",
      skip: "Skipped",
      extract: "Extracting",
      done: "Done",
      missing: "Missing",
    },
    fileStatus: {
      new: "New",
      indexed: "Indexed",
      changed: "Needs update",
      missing: "Missing",
    },
  },
} as const;

const EMBED_HINTS = ["embed", "embedding", "bge", "e5", "nomic-embed", "gte", "instructor"];
const SUPPORTED_EXTS = ["pdf", "txt", "md", "markdown", "docx"];
const OLLAMA_URL = "https://ollama.com/download";

function isEmbeddingModel(name: string) {
  const lower = name.toLowerCase();
  return EMBED_HINTS.some((hint) => lower.includes(hint));
}

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
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

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function deriveTitle(messages: ChatMessage[], fallback: string) {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return fallback;
  return firstUser.text.slice(0, 48);
}

function getMissingModels(models: string[], defaults: { chat: string; embed: string }) {
  const missing: string[] = [];
  if (!models.includes(defaults.chat)) missing.push(defaults.chat);
  if (!models.includes(defaults.embed)) missing.push(defaults.embed);
  return missing;
}

export default function App() {
  const [lang, setLang] = useState<Lang>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.lang);
    if (saved === "pl" || saved === "en") return saved;
    return navigator.language.toLowerCase().startsWith("pl") ? "pl" : "en";
  });
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.theme);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
    return "system";
  });

  const [setupState, setSetupState] = useState<SetupState>("checking");
  const [setupMessage, setSetupMessage] = useState("");
  const [setupLogs, setSetupLogs] = useState<string[]>([]);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupComplete, setSetupComplete] = useState<boolean>(() =>
    loadJson(STORAGE_KEYS.setupComplete, false),
  );
  const [missingModels, setMissingModels] = useState<string[]>([]);
  const [ollamaRunning, setOllamaRunning] = useState(false);
  const [setupDefaults, setSetupDefaults] = useState<{ chat: string; embed: string }>({
    chat: "llama3.1:8b",
    embed: "qwen3-embedding",
  });
  const [watcherInfo, setWatcherInfo] = useState<WatcherStatus | null>(null);
  const [reindexInfo, setReindexInfo] = useState<ReindexProgress | null>(null);

  const [targets, setTargets] = useState<IndexTarget[]>([]);
  const [targetsLoaded, setTargetsLoaded] = useState(false);
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

  const [indexSettings, setIndexSettings] = useState<IndexSettings>(() =>
    loadJson(STORAGE_KEYS.indexSettings, DEFAULT_INDEX_SETTINGS),
  );
  const [retrievalSettings, setRetrievalSettings] = useState<RetrievalSettings>(() =>
    loadJson(STORAGE_KEYS.retrievalSettings, DEFAULT_RETRIEVAL_SETTINGS),
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [q, setQ] = useState("");
  const [log, setLog] = useState<ChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);

  const [sessions, setSessions] = useState<ChatSession[]>(() =>
    loadJson(STORAGE_KEYS.sessions, [] as ChatSession[]),
  );
  const [activeSessionId, setActiveSessionId] = useState<string>(
    loadJson(STORAGE_KEYS.activeSession, ""),
  );

  const t = copy[lang];

  async function startSetup() {
    setSetupState("running");
    setSetupMessage(t.setupRunning);
    setSetupError(null);
    setSetupLogs([]);
    try {
      await invoke("run_setup");
    } catch (err) {
      setSetupError(String(err));
      setSetupState("needs");
    }
  }

  async function checkSetup(forceSetupComplete = setupComplete) {
    setSetupError(null);
    setSetupMessage("");
    setSetupState("checking");
    setSetupLogs([]);
    try {
      const status = (await invoke("setup_status")) as SetupStatus;
      setOllamaRunning(status.running);
      const defaults = { chat: status.defaultChat, embed: status.defaultEmbed };
      setSetupDefaults(defaults);

      if (!status.running) {
        setMissingModels(getMissingModels([], defaults));
        setSetupState("needs");
        return;
      }

      const missing = getMissingModels(status.models, defaults);
      setMissingModels(missing);

      if (!forceSetupComplete && missing.length > 0) {
        await startSetup();
        return;
      }

      if (!forceSetupComplete && missing.length === 0) {
        setSetupComplete(true);
      }

      setSetupState("ready");
    } catch (err) {
      setSetupError(String(err));
      setSetupState("needs");
    }
  }

  function rerunSetup() {
    setSetupComplete(false);
    setSetupLogs([]);
    checkSetup(false);
  }

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.lang, lang);
  }, [lang]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.theme, theme);
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.setupComplete, JSON.stringify(setupComplete));
  }, [setupComplete]);

  useEffect(() => {
    checkSetup();
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.indexSettings, JSON.stringify(indexSettings));
  }, [indexSettings]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.retrievalSettings, JSON.stringify(retrievalSettings));
  }, [retrievalSettings]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.activeSession, JSON.stringify(activeSessionId));
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId && sessions.length === 0) {
      const id = newId();
      const session: ChatSession = {
        id,
        title: t.newChat,
        createdAt: Date.now(),
        messages: [],
      };
      setSessions([session]);
      setActiveSessionId(id);
      setLog([]);
    }
  }, [activeSessionId, sessions.length, t.newChat]);

  useEffect(() => {
    if (!activeSessionId && sessions.length > 0) {
      setActiveSessionId(sessions[0].id);
    } else if (activeSessionId && sessions.length > 0) {
      const exists = sessions.some((s) => s.id === activeSessionId);
      if (!exists) {
        setActiveSessionId(sessions[0].id);
      }
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    if (!activeSessionId) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (session) {
      setLog(session.messages);
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    if (!activeSessionId) return;
    setSessions((prev) =>
      prev.map((session) =>
        session.id === activeSessionId
          ? {
              ...session,
              messages: log,
              title: deriveTitle(log, session.title || t.newChat),
            }
          : session,
      ),
    );
  }, [log, activeSessionId, t.newChat]);

  async function loadModels() {
    setModelsBusy(true);
    setModelError(null);
    try {
      const res = (await invoke("list_models")) as string[];
      setModels(res);

      const embedCandidates = res.filter(isEmbeddingModel);
      const chatCandidates = res.filter((m) => !isEmbeddingModel(m));
      const defaultChat = setupDefaults.chat || "llama3.1:8b";
      const defaultEmbed = setupDefaults.embed || "qwen3-embedding";

      if (!chatTouched && !chatModel) {
        setChatModel(
          res.includes(defaultChat) ? defaultChat : chatCandidates[0] ?? res[0] ?? "",
        );
      }
      if (!embedTouched && !embedModel) {
        setEmbedModel(
          res.includes(defaultEmbed) ? defaultEmbed : embedCandidates[0] ?? res[0] ?? "",
        );
      }
    } catch (err) {
      setModelError(String(err));
    } finally {
      setModelsBusy(false);
    }
  }

  useEffect(() => {
    if (setupState === "ready") {
      loadModels();
    }
  }, [setupState]);

  useEffect(() => {
    invoke("list_targets")
      .then((res) => {
        const incoming = (res as Omit<IndexTarget, "id">[]).map((tgt) => ({
          ...tgt,
          id: newId(),
        }));
        setTargets(incoming);
      })
      .catch(() => {})
      .finally(() => setTargetsLoaded(true));
  }, []);

  useEffect(() => {
    if (!targetsLoaded) return;
    const timer = setTimeout(() => {
      const payload = targets.map(({ path, kind, includeSubfolders }) => ({
        path,
        kind,
        includeSubfolders,
      }));
      invoke("save_targets", { targets: payload }).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [targets, targetsLoaded]);

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
    let unlistenSetup: (() => void) | null = null;
    let unlistenSetupDone: (() => void) | null = null;
    let unlistenSetupError: (() => void) | null = null;
    let unlistenModelPull: (() => void) | null = null;
    let unlistenWatcher: (() => void) | null = null;
    let unlistenReindex: (() => void) | null = null;

    listen<SetupProgress>("setup_progress", (event) => {
      setSetupState("running");
      setSetupMessage(event.payload.message);
      setSetupLogs((prev) => [...prev.slice(-200), event.payload.message]);
    }).then((unlisten) => {
      unlistenSetup = unlisten;
    });

    listen<ModelPullProgress>("model_pull_progress", (event) => {
      const line = `[${event.payload.model}] ${event.payload.line}`;
      setSetupLogs((prev) => [...prev.slice(-200), line]);
    }).then((unlisten) => {
      unlistenModelPull = unlisten;
    });

    listen<boolean>("setup_done", () => {
      setSetupComplete(true);
      setSetupState("ready");
      setSetupMessage("");
      setSetupError(null);
    }).then((unlisten) => {
      unlistenSetupDone = unlisten;
    });

    listen<string>("setup_error", (event) => {
      setSetupError(event.payload);
      setSetupState("needs");
    }).then((unlisten) => {
      unlistenSetupError = unlisten;
    });

    listen<WatcherStatus>("watcher_status", (event) => {
      setWatcherInfo(event.payload);
    }).then((unlisten) => {
      unlistenWatcher = unlisten;
    });

    listen<ReindexProgress>("reindex_progress", (event) => {
      setReindexInfo(event.payload);
    }).then((unlisten) => {
      unlistenReindex = unlisten;
    });

    return () => {
      unlistenSetup?.();
      unlistenSetupDone?.();
      unlistenSetupError?.();
      unlistenModelPull?.();
      unlistenWatcher?.();
      unlistenReindex?.();
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
        else if (f.status === "missing") acc.missing += 1;
        else acc.new += 1;
        return acc;
      },
      { total: 0, indexed: 0, changed: 0, new: 0, missing: 0 },
    );
  }, [previewFiles]);

  async function addFolders() {
    const res = await openDialog({ directory: true, multiple: true });
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
    const res = await openDialog({
      multiple: true,
      filters: [{ name: "Documents", extensions: SUPPORTED_EXTS }],
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
      await invoke("start_index", {
        targets: payload,
        embed_model: embedModel,
        settings: indexSettings,
      });
    } catch (err) {
      setIndexError(String(err));
      setIndexing(false);
    }
  }

  async function reindexFile(path: string) {
    if (!embedModel) return;
    setIndexError(null);
    setIndexing(true);
    try {
      await invoke("reindex_files", {
        files: [path],
        embed_model: embedModel,
        settings: indexSettings,
      });
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
        settings: retrievalSettings,
      })) as ChatResponse;
      setLog((l) => [...l, { role: "assistant", text: resp.answer, sources: resp.sources }]);
    } finally {
      setChatBusy(false);
    }
  }

  function createNewChat() {
    const id = newId();
    const session: ChatSession = {
      id,
      title: t.newChat,
      createdAt: Date.now(),
      messages: [],
    };
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(id);
    setLog([]);
  }

  function deleteChat(id: string) {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (id === activeSessionId) {
      const remaining = sessions.filter((s) => s.id !== id);
      if (remaining.length > 0) {
        setActiveSessionId(remaining[0].id);
      } else {
        createNewChat();
      }
    }
  }

  const embedOptions = models.filter(isEmbeddingModel);
  const embedList = embedOptions.length > 0 ? embedOptions : models;

  const activeSessions = useMemo(() => {
    return [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  }, [sessions]);

  const watcherLabel = watcherInfo?.status === "watching" ? t.watcherWatching : watcherInfo?.status;
  const reindexLabel = reindexInfo
    ? reindexInfo.status === "queued"
      ? t.reindexQueued
      : reindexInfo.status === "done"
        ? t.reindexDone
        : reindexInfo.status === "error"
          ? t.reindexError
          : reindexInfo.status
    : "";
  const setupStatusText =
    setupState === "checking"
      ? t.setupChecking
      : setupState === "running"
        ? t.setupRunning
        : !ollamaRunning
          ? t.ollamaNotRunning
          : setupMessage || t.setupReady;

  if (setupState !== "ready") {
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

        <div className="setup">
          <section className="card setup-card">
            <div className="card-header">
              <h2>{t.setupTitle}</h2>
            </div>
            <div className="hint">{t.setupSubtitle}</div>
            <div className="setup-status">
              <div className="status-row">
                <span className="badge neutral">{setupStatusText}</span>
              </div>
              {setupError && (
                <div className="error">
                  {t.setupError}: {setupError}
                </div>
              )}
              {!ollamaRunning && <div className="hint">{t.setupHint}</div>}
            </div>

            <div className="setup-models">
              <div className="meta">{t.requiredModels}</div>
              <div className="setup-chips">
                <span className="badge neutral">{setupDefaults.chat}</span>
                <span className="badge neutral">{setupDefaults.embed}</span>
              </div>
              {missingModels.length > 0 && (
                <div className="setup-missing">
                  <div className="meta">{t.missingModels}</div>
                  <div className="setup-chips">
                    {missingModels.map((m) => (
                      <span className="badge warn" key={m}>{m}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="card-actions setup-actions">
              <button className="ghost" onClick={() => openPath(OLLAMA_URL)} disabled={setupState === "running"}>
                {t.installOllama}
              </button>
              <button className="primary" onClick={() => checkSetup()} disabled={setupState === "running"}>
                {t.retry}
              </button>
            </div>

            {setupLogs.length > 0 && (
              <div className="setup-logs">
                <div className="meta">{t.setupLogs}</div>
                <pre>{setupLogs.join("\n")}</pre>
              </div>
            )}
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-title">{t.appTitle}</div>
          <div className="brand-subtitle">{t.appSubtitle}</div>
        </div>
        <div className="topbar-controls">
          <button className="ghost small" onClick={rerunSetup}>{t.reRunSetup}</button>
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
                {t.filesSummary}: {fileCounts.total} | {t.filesNew}: {fileCounts.new} | {t.filesIndexed}: {fileCounts.indexed} | {t.filesChanged}: {fileCounts.changed} | {t.filesMissing}: {fileCounts.missing}
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
                  file.status === "indexed"
                    ? "badge good"
                    : file.status === "changed"
                      ? "badge warn"
                      : file.status === "missing"
                        ? "badge neutral"
                        : "badge neutral";
                const sizeLabel = formatSize(file.size);
                return (
                  <div className="file-row" key={file.path}>
                    <div className="file-main">
                      <div className="file-path">{file.path}</div>
                      <div className="file-meta">
                        {file.kind.toUpperCase()}
                        {sizeLabel ? ` | ${sizeLabel}` : ""}
                      </div>
                    </div>
                    <div className="file-actions">
                      <span className={badgeClass}>{statusLabel}</span>
                      {file.status !== "missing" && (
                        <button className="ghost small" onClick={() => reindexFile(file.path)}>
                          {t.refreshFile}
                        </button>
                      )}
                    </div>
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
              <button className="ghost small" onClick={() => setAdvancedOpen((v) => !v)}>
                {t.advancedToggle}
              </button>
            </div>
            <div className="field inline">
              <label>{t.topK}</label>
              <input
                type="number"
                min={1}
                max={50}
                value={retrievalSettings.topK}
                onChange={(e) =>
                  setRetrievalSettings((s) => ({ ...s, topK: Number(e.target.value) }))
                }
              />
            </div>
            {advancedOpen && (
              <div className="advanced-grid">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={retrievalSettings.useMmr}
                    onChange={(e) => setRetrievalSettings((s) => ({ ...s, useMmr: e.target.checked }))}
                  />
                  <span>{t.useMmr}</span>
                </label>
                <div className="field">
                  <label>{t.mmrLambda}</label>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={retrievalSettings.mmrLambda}
                    onChange={(e) =>
                      setRetrievalSettings((s) => ({ ...s, mmrLambda: Number(e.target.value) }))
                    }
                  />
                </div>
                <div className="field">
                  <label>{t.mmrCandidates}</label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={retrievalSettings.mmrCandidates}
                    onChange={(e) =>
                      setRetrievalSettings((s) => ({ ...s, mmrCandidates: Number(e.target.value) }))
                    }
                  />
                </div>
                <div className="field">
                  <label>{t.maxDistance}</label>
                  <input
                    type="number"
                    min={0}
                    step={0.05}
                    value={retrievalSettings.maxDistance ?? ""}
                    onChange={(e) =>
                      setRetrievalSettings((s) => ({
                        ...s,
                        maxDistance: e.target.value === "" ? null : Number(e.target.value),
                      }))
                    }
                  />
                </div>
              </div>
            )}
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
              {watcherInfo && (
                <div className="status-row">
                  <span className="status-label">{t.watcherStatus}</span>
                  <span>{watcherLabel} | {watcherInfo.watched}</span>
                </div>
              )}
              {reindexInfo && (
                <div className="status-row">
                  <span className="status-label">{t.reindexStatus}</span>
                  <span>{reindexLabel} | {reindexInfo.files.length}</span>
                </div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-header">
              <h2>{t.advancedTitle}</h2>
            </div>
            <div className="advanced-grid">
              <div className="field">
                <label>{t.chunkSize}</label>
                <input
                  type="number"
                  min={200}
                  max={4000}
                  value={indexSettings.chunkSize}
                  onChange={(e) =>
                    setIndexSettings((s) => ({ ...s, chunkSize: Number(e.target.value) }))
                  }
                />
              </div>
              <div className="field">
                <label>{t.chunkOverlap}</label>
                <input
                  type="number"
                  min={0}
                  max={1000}
                  value={indexSettings.chunkOverlap}
                  onChange={(e) =>
                    setIndexSettings((s) => ({ ...s, chunkOverlap: Number(e.target.value) }))
                  }
                />
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={indexSettings.ocrEnabled}
                  onChange={(e) =>
                    setIndexSettings((s) => ({ ...s, ocrEnabled: e.target.checked }))
                  }
                />
                <span>{t.ocrEnabled}</span>
              </label>
              <div className="field">
                <label>{t.ocrLang}</label>
                <input
                  value={indexSettings.ocrLang}
                  onChange={(e) =>
                    setIndexSettings((s) => ({ ...s, ocrLang: e.target.value }))
                  }
                />
              </div>
              <div className="field">
                <label>{t.ocrMinChars}</label>
                <input
                  type="number"
                  min={0}
                  max={5000}
                  value={indexSettings.ocrMinChars}
                  onChange={(e) =>
                    setIndexSettings((s) => ({ ...s, ocrMinChars: Number(e.target.value) }))
                  }
                />
              </div>
              <div className="field">
                <label>{t.ocrDpi}</label>
                <input
                  type="number"
                  min={150}
                  max={600}
                  value={indexSettings.ocrDpi}
                  onChange={(e) =>
                    setIndexSettings((s) => ({ ...s, ocrDpi: Number(e.target.value) }))
                  }
                />
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-header">
              <h2>{t.historyTitle}</h2>
              <button className="ghost small" onClick={createNewChat}>
                {t.newChat}
              </button>
            </div>
            {activeSessions.length === 0 && <div className="empty">{t.emptyChat}</div>}
            <div className="history-list">
              {activeSessions.map((session) => (
                <div className={`history-row ${session.id === activeSessionId ? "active" : ""}`} key={session.id}>
                  <div className="history-main">
                    <div className="history-title">{session.title || t.newChat}</div>
                    <div className="history-meta">{new Date(session.createdAt).toLocaleString()}</div>
                  </div>
                  <div className="history-actions">
                    <button className="ghost small" onClick={() => setActiveSessionId(session.id)}>
                      {t.loadChat}
                    </button>
                    <button className="ghost small" onClick={() => deleteChat(session.id)}>
                      {t.deleteChat}
                    </button>
                  </div>
                </div>
              ))}
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
              <div className="empty">{t.emptyChat}</div>
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
