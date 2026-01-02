import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import "./App.css";

type SourceHit = { file_path: string; page: number; snippet: string; distance: number };
type ChatResponse = { answer: string; sources: SourceHit[] };
type IndexProgress = { current: number; total: number; file: string; status: string };
type SetupStatus = { running: boolean; models: string[]; defaultChat: string; defaultFast: string; defaultEmbed: string };
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
type Theme = "light" | "dark";
type View = "chat" | "sources" | "history";
type SourcesTab = "targets" | "files";

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
  useMmr: false,
  mmrLambda: 0.7,
  mmrCandidates: 24,
};

const STORAGE_KEYS = {
  lang: "ui.lang",
  theme: "ui.theme",
  ollamaHost: "ollama.host",
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
    setupHint: "Po instalacji Ollama kliknij przycisk Spróbuj ponownie.",
    installOllama: "Zainstaluj Ollama",
    retry: "Spróbuj ponownie",
    requiredModels: "Wymagane modele",
    missingModels: "Brakujące modele",
    reRunSetup: "Uruchom ponownie setup",
    setupClose: "Zamknij",
    setupHost: "Adres Ollama",
    setupHostHint: "Domyślnie: http://127.0.0.1:11434",
    setupModelsTitle: "Modele domyślne",
    setupSourcesTitle: "Domyślne źródła",
    setupSourcesHint: "Opcjonalnie dodaj foldery lub pliki startowe.",
    ollamaNotRunning: "Ollama nie jest uruchomiona.",
    setupLogs: "Logi instalacji",
    watcherStatus: "WATCHER",
    watcherWatching: "Monitor aktywny",
    reindexStatus: "Auto-reindeksacja",
    reindexQueued: "W kolejce",
    reindexDone: "Zakończono",
    reindexError: "Błąd",
    language: "Język",
    theme: "Motyw",
    themeLight: "Jasny",
    themeDark: "Ciemny",
    openSettings: "Ustawienia",
    settingsTitle: "Ustawienia",
    settingsHint: "Skonfiguruj aplikację i modele.",
    settingsGeneral: "Ogólne",
    settingsSearch: "Wyszukiwanie",
    settingsIndexing: "Indeksowanie",
    close: "Zamknij",
    navChat: "Czat",
    navSources: "Źródła",
    navHistory: "Historia",
    navSettings: "Ustawienia",
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
    modelsUnavailable: "Nie można połączyć się z Ollama. Uruchom usługę i spróbuj ponownie.",
    ollamaHealth: "Status Ollama",
    ollamaHealthOk: "Połączenie OK",
    ollamaHealthError: "Błąd Ollama",
    retrievalTitle: "Ustawienia wyszukiwania",
    topK: "Top K",
    filesTitle: "Pliki do indeksu",
    filesSummary: "Wykryto",
    filesNew: "Nowe",
    filesIndexed: "Zaindeksowane",
    filesChanged: "Do aktualizacji",
    filesMissing: "Brak pliku",
    filesEmpty: "Brak plików do indeksu.",
    filterFiles: "Filtruj listę plików...",
    sourcesSearch: "Szukaj źródeł...",
    perPage: "Na stronie",
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
    chatThinking: "Myśli...",
    chatStreaming: "Strumień",
    chatFinalized: "Finalna",
    chatReady: "Gotowy",
    chatError: "Błąd",
    modelHint: "Modele są pobierane z lokalnej instancji Ollama.",
    advancedTitle: "Ustawienia zaawansowane",
    advancedToggleShow: "Pokaż ustawienia",
    advancedToggleHide: "Ukryj ustawienia",
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
    languageHelp: "Jezyk interfejsu aplikacji.",
    themeHelp: "Przelacz jasny lub ciemny motyw.",
    chatModelHelp: "Model uzywany do odpowiedzi w czacie.",
    embedModelHelp: "Model do generowania embeddingow dla wyszukiwania.",
    topKHelp: "Ile najlepszych wynikow zwracac na zapytanie.",
    useMmrHelp: "Uzyj MMR, aby zwiekszyc roznorodnosc zrodel.",
    mmrLambdaHelp: "Balans miedzy trafnoscia (1) i roznorodnoscia (0).",
    mmrCandidatesHelp: "Liczba kandydatow rozwazanych przez MMR.",
    maxDistanceHelp: "Maksymalny dystans wyniku (nizszy = bardziej restrykcyjny).",
    chunkSizeHelp: "Liczba znakow na chunk podczas indeksowania.",
    chunkOverlapHelp: "Nakladanie chunkow, by zachowac kontekst.",
    ocrEnabledHelp: "Wlacz OCR dla skanowanych PDF przed indeksowaniem.",
    ocrLangHelp: "Jezyki OCR, np. \"eng+pol\".",
    ocrMinCharsHelp: "Pomin OCR, jesli wykryty tekst ma co najmniej tyle znakow.",
    ocrDpiHelp: "DPI renderowania dla OCR; wyzszy = wolniej, ale lepiej.",
    historyTitle: "Historia rozmów",
    newChat: "Nowa rozmowa",
    loadChat: "Wczytaj",
    deleteChat: "Usuń",
    remove: "Usuń",
    deleteTitle: "Usuń rozmowę",
    cancel: "Anuluj",
    prev: "Poprzednia",
    next: "Następna",
    confirmDeleteChat: "Czy na pewno usunąć rozmowę?",
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
      error: "Błąd",
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
    reRunSetup: "Run setup again",
    setupClose: "Close",
    setupHost: "Ollama host",
    setupHostHint: "Default: http://127.0.0.1:11434",
    setupModelsTitle: "Default models",
    setupSourcesTitle: "Default sources",
    setupSourcesHint: "Optionally add starter folders or files.",
    ollamaNotRunning: "Ollama is not running.",
    setupLogs: "Setup logs",
    watcherStatus: "WATCHER",
    watcherWatching: "Active monitor",
    reindexStatus: "Auto reindex",
    reindexQueued: "Queued",
    reindexDone: "Done",
    reindexError: "Error",
    language: "Language",
    theme: "Theme",
    themeLight: "Light",
    themeDark: "Dark",
    openSettings: "Settings",
    settingsTitle: "Settings",
    settingsHint: "Configure the app and models.",
    settingsGeneral: "General",
    settingsSearch: "Search",
    settingsIndexing: "Indexing",
    close: "Close",
    navChat: "Chat",
    navSources: "Sources",
    navHistory: "History",
    navSettings: "Settings",
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
    modelsUnavailable: "Cannot reach Ollama. Start it and try again.",
    ollamaHealth: "Ollama health",
    ollamaHealthOk: "Connection OK",
    ollamaHealthError: "Ollama error",
    retrievalTitle: "Search settings",
    topK: "Top K",
    filesTitle: "Files to index",
    filesSummary: "Detected",
    filesNew: "New",
    filesIndexed: "Indexed",
    filesChanged: "Needs update",
    filesMissing: "Missing",
    filesEmpty: "No files to index.",
    filterFiles: "Filter file list...",
    sourcesSearch: "Search sources...",
    perPage: "Per page",
    refreshFile: "Refresh",
    chatTitle: "Chat",
    askPlaceholder: "Ask about your documents...",
    send: "Send",
    you: "You",
    assistant: "Assistant",
    sourcesLabel: "Sources",
    openFile: "Open",
    reveal: "Reveal in folder",
    status: "Status",
    progress: "Progress",
    chatThinking: "Thinking...",
    chatStreaming: "Streaming",
    chatFinalized: "Finalized",
    chatReady: "Ready",
    chatError: "Error",
    modelHint: "Models are fetched from your local Ollama instance.",
    advancedTitle: "Advanced settings",
    advancedToggleShow: "Show settings",
    advancedToggleHide: "Hide settings",
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
    languageHelp: "App UI language.",
    themeHelp: "Switch between light and dark themes.",
    chatModelHelp: "Model used for chat responses.",
    embedModelHelp: "Model used to generate embeddings for search.",
    topKHelp: "How many top matches to return per query.",
    useMmrHelp: "Use MMR to diversify sources.",
    mmrLambdaHelp: "Balance between relevance (1) and diversity (0).",
    mmrCandidatesHelp: "Number of candidates considered by MMR.",
    maxDistanceHelp: "Maximum allowed distance (lower is stricter).",
    chunkSizeHelp: "Characters per chunk when indexing.",
    chunkOverlapHelp: "Overlap between chunks to preserve context.",
    ocrEnabledHelp: "Run OCR on scanned PDFs before indexing.",
    ocrLangHelp: "OCR languages, e.g. \"eng+pol\".",
    ocrMinCharsHelp: "Skip OCR if extracted text has at least this many characters.",
    ocrDpiHelp: "OCR rendering DPI; higher is slower but clearer.",
    historyTitle: "Chat history",
    newChat: "New chat",
    loadChat: "Load",
    deleteChat: "Delete",
    remove: "Remove",
    deleteTitle: "Delete chat",
    cancel: "Cancel",
    prev: "Previous",
    next: "Next",
    confirmDeleteChat: "Delete this chat?",
    emptyChat: "Start chatting to see answers from your documents.",
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
      error: "Error",
    },
  },
} as const;

const EMBED_HINTS = ["embed", "embedding", "bge", "e5", "nomic-embed", "gte", "instructor"];
const SUPPORTED_EXTS = ["pdf", "txt", "md", "markdown", "docx"];
const DEFAULT_CHAT_MODEL = "llama3.1:8b";
const DEFAULT_FAST_CHAT_MODEL = "llama3.2:3b";
const DEFAULT_EMBED_MODEL = "qwen3-embedding";
const OLLAMA_URL = "https://ollama.com/download";
const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
const SETUP_MODAL_ANIM_MS = 240;

export function isEmbeddingModel(name: string) {
  const lower = name.toLowerCase();
  return EMBED_HINTS.some((hint) => lower.includes(hint));
}

export function formatSize(bytes: number) {
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

export function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function deriveTitle(messages: ChatMessage[], fallback: string) {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return fallback;
  return firstUser.text.slice(0, 48);
}

export function splitModelTag(name: string) {
  const idx = name.lastIndexOf(":");
  if (idx <= 0 || idx === name.length - 1) return { base: name, tag: null };
  return { base: name.slice(0, idx), tag: name.slice(idx + 1) };
}

export function modelInstalled(models: string[], required: string) {
  const req = splitModelTag(required);
  return models.some((model) => {
    const m = splitModelTag(model);
    if (req.tag) {
      return model === required || (!m.tag && m.base === req.base);
    }
    return m.base === req.base;
  });
}

export function getMissingModels(models: string[], defaults: { chat: string; fast: string; embed: string }) {
  const required = [defaults.chat, defaults.fast, defaults.embed];
  const missing = required.filter((model) => !modelInstalled(models, model));
  return Array.from(new Set(missing));
}

function extractOllamaError(err: unknown) {
  const raw = String(err ?? "");
  const idx = raw.indexOf("Ollama error ");
  if (idx === -1) return null;
  return raw.slice(idx);
}

type IconProps = {
  children: ReactNode;
  className?: string;
  viewBox?: string;
};

function Icon({ children, className = "icon", viewBox = "0 0 24 24" }: IconProps) {
  return (
    <svg
      className={className}
      viewBox={viewBox}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const Icons = {
  gear: (
    <Icon>
      <path d="M12 8.25a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5Z" />
      <path d="M19.4 12.01a7.46 7.46 0 0 0 0-0.02l1.9-1.47-1.9-3.3-2.28.68a7.62 7.62 0 0 0-1.2-.7L15.5 4h-3l-.42 2.2a7.62 7.62 0 0 0-1.2.7l-2.28-.68-1.9 3.3 1.9 1.47a7.46 7.46 0 0 0 0 .02l-1.9 1.47 1.9 3.3 2.28-.68c.37.28.78.52 1.2.7l.42 2.2h3l.42-2.2c.42-.18.83-.42 1.2-.7l2.28.68 1.9-3.3-1.9-1.47Z" />
    </Icon>
  ),
  chat: (
    <Icon>
      <path d="M5 5h14a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H9l-5 4v-4H5a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z" />
      <path d="M8 10h8M8 14h5" />
    </Icon>
  ),
  folder: (
    <Icon>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </Icon>
  ),
  file: (
    <Icon>
      <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v5h5" />
    </Icon>
  ),
  history: (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v5l3 2" />
    </Icon>
  ),
  plus: (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  ),
  close: (
    <Icon>
      <path d="M6 6l12 12M18 6l-12 12" />
    </Icon>
  ),
  send: (
    <Icon>
      <path d="M3 11l18-7-7 18-2-7-9-4Z" />
    </Icon>
  ),
  refresh: (
    <Icon>
      <path d="M4 4v6h6M20 20v-6h-6" />
      <path d="M20 11a7 7 0 0 0-12.2-4.9M4 13a7 7 0 0 0 12.2 4.9" />
    </Icon>
  ),
  trash: (
    <Icon>
      <path d="M4 7h16" />
      <path d="M9 7V5h6v2" />
      <path d="M7 7l1 13h8l1-13" />
      <path d="M10 11v6M14 11v6" />
    </Icon>
  ),
  play: (
    <Icon>
      <path d="M8 5l10 7-10 7V5Z" fill="currentColor" stroke="none" />
    </Icon>
  ),
  search: (
    <Icon>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </Icon>
  ),
  list: (
    <Icon>
      <path d="M4 6h16M4 12h16M4 18h10" />
    </Icon>
  ),
  check: (
    <Icon>
      <path d="M5 13l4 4L19 7" />
    </Icon>
  ),
  arrowLeft: (
    <Icon>
      <path d="M15 6l-6 6 6 6" />
    </Icon>
  ),
  arrowRight: (
    <Icon>
      <path d="M9 6l6 6-6 6" />
    </Icon>
  ),
  load: (
    <Icon>
      <path d="M12 5v9" />
      <path d="M8 10l4 4 4-4" />
      <path d="M5 19h14" />
    </Icon>
  ),
  download: (
    <Icon>
      <path d="M12 4v10" />
      <path d="M8 10l4 4 4-4" />
      <path d="M5 20h14" />
    </Icon>
  ),
  alert: (
    <Icon>
      <path d="M12 4l8 14H4l8-14Z" />
      <path d="M12 9v4M12 17h.01" />
    </Icon>
  ),
  info: (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 10v6" />
      <path d="M12 7h.01" />
    </Icon>
  ),
  user: (
    <Icon>
      <circle cx="12" cy="8" r="3" />
      <path d="M5 20c1.6-3 12.4-3 14 0" />
    </Icon>
  ),
} as const;

type HelpIconProps = {
  text: string;
};

function HelpIcon({ text }: HelpIconProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const [shift, setShift] = useState(0);

  function updateTooltipShift() {
    const button = buttonRef.current;
    const tooltip = tooltipRef.current;
    if (!button || !tooltip) return;

    const tooltipWidth = tooltip.offsetWidth;
    if (!tooltipWidth) return;

    const buttonRect = button.getBoundingClientRect();
    const panel = button.closest(".settings-panel");
    const panelRect = panel?.getBoundingClientRect();
    const margin = 12;
    const leftBoundary = (panelRect?.left ?? 0) + margin;
    const rightBoundary = (panelRect?.right ?? window.innerWidth) - margin;
    const defaultLeft = buttonRect.left + buttonRect.width / 2 - tooltipWidth / 2;
    const maxLeft = rightBoundary - tooltipWidth;
    const clampedLeft = maxLeft < leftBoundary ? leftBoundary : Math.min(Math.max(defaultLeft, leftBoundary), maxLeft);
    const nextShift = Math.round(clampedLeft - defaultLeft);

    if (nextShift !== shift) {
      setShift(nextShift);
    }
  }

  const tooltipStyle = { "--tooltip-shift": `${shift}px` } as CSSProperties;

  return (
    <button
      ref={buttonRef}
      type="button"
      className="help-icon"
      aria-label={text}
      onMouseEnter={updateTooltipShift}
      onFocus={updateTooltipShift}
      style={tooltipStyle}
    >
      {Icons.info}
      <span ref={tooltipRef} className="help-tooltip" aria-hidden="true">
        {text}
      </span>
    </button>
  );
}

export default function App() {
  const [lang, setLang] = useState<Lang>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.lang);
    if (saved === "pl" || saved === "en") return saved;
    return navigator.language.toLowerCase().startsWith("pl") ? "pl" : "en";
  });
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.theme);
    if (saved === "light" || saved === "dark") return saved;
    if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
    return "light";
  });
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupVisible, setSetupVisible] = useState(false);
  const [setupActive, setSetupActive] = useState(false);
  const [setupPinned, setSetupPinned] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<View>("chat");
  const [sourcesTab, setSourcesTab] = useState<SourcesTab>("targets");
  const [sourcesQuery, setSourcesQuery] = useState("");
  const [sourcesPage, setSourcesPage] = useState(0);
  const [sourcesPageSize, setSourcesPageSize] = useState(25);
  const [filesPage, setFilesPage] = useState(0);
  const [filesPageSize, setFilesPageSize] = useState(25);
  const [ollamaHost, setOllamaHost] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.ollamaHost);
    if (saved === "http://localhost:11434") return DEFAULT_OLLAMA_HOST;
    return saved ?? DEFAULT_OLLAMA_HOST;
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
  const [setupDefaults, setSetupDefaults] = useState<{ chat: string; fast: string; embed: string }>({
    chat: DEFAULT_CHAT_MODEL,
    fast: DEFAULT_FAST_CHAT_MODEL,
    embed: DEFAULT_EMBED_MODEL,
  });
  const [watcherInfo, setWatcherInfo] = useState<WatcherStatus | null>(null);
  const [reindexInfo, setReindexInfo] = useState<ReindexProgress | null>(null);

  const [targets, setTargets] = useState<IndexTarget[]>([]);
  const [targetsLoaded, setTargetsLoaded] = useState(false);
  const [previewFiles, setPreviewFiles] = useState<IndexFilePreview[]>([]);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewFilter, setPreviewFilter] = useState("");
  const deferredSourcesQuery = useDeferredValue(sourcesQuery);
  const deferredPreviewFilter = useDeferredValue(previewFilter);
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
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatStreaming, setChatStreaming] = useState(false);
  const [chatFinalized, setChatFinalized] = useState(false);
  const [ollamaHealth, setOllamaHealth] = useState<{ status: "ok" | "error"; message?: string }>(() => ({
    status: "ok",
  }));
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const streamSessionRef = useRef<string | null>(null);

  const [sessions, setSessions] = useState<ChatSession[]>(() =>
    loadJson(STORAGE_KEYS.sessions, [] as ChatSession[]),
  );
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; sessionId: string | null }>({
    open: false,
    sessionId: null,
  });

  const t = copy[lang];
  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const log = activeSession?.messages ?? [];

  function markOllamaOk() {
    setOllamaHealth({ status: "ok" });
  }

  function markOllamaError(err: unknown) {
    const msg = extractOllamaError(err);
    if (msg) {
      setOllamaHealth({ status: "error", message: msg });
    }
  }

  async function startSetup() {
    setSetupState("running");
    setSetupMessage(t.setupRunning);
    setSetupError(null);
    setSetupLogs([]);
    try {
      await syncOllamaHost();
      await invoke("run_setup");
      markOllamaOk();
    } catch (err) {
      setSetupError(String(err));
      markOllamaError(err);
      setSetupState("needs");
    }
  }

  async function syncOllamaHost(nextHost = ollamaHost) {
    const host = nextHost.trim();
    try {
      await invoke("set_ollama_host", { host });
    } catch {
      // ignore to avoid blocking UI
    }
  }

  async function checkSetup(forceSetupComplete = setupComplete) {
    setSetupError(null);
    setSetupMessage("");
    setSetupState("checking");
    setSetupLogs([]);
    try {
      await syncOllamaHost();
      const status = (await invoke("setup_status")) as SetupStatus;
      if (status.running) {
        markOllamaOk();
      }
      setOllamaRunning(status.running);
      const defaults = { chat: status.defaultChat, fast: status.defaultFast, embed: status.defaultEmbed };
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
      markOllamaError(err);
      setSetupState("needs");
    }
  }

  function rerunSetup() {
    setSetupComplete(false);
    setSetupLogs([]);
    checkSetup(false);
  }

  function openSetupWizard() {
    setSettingsOpen(false);
    setSetupPinned(true);
    setSetupOpen(true);
    rerunSetup();
  }

  useEffect(() => {
    if (setupOpen) {
      if (!setupVisible) setSetupVisible(true);
      const raf = window.requestAnimationFrame(() => setSetupActive(true));
      return () => window.cancelAnimationFrame(raf);
    }

    setSetupActive(false);
    if (setupVisible) {
      const timeout = window.setTimeout(() => setSetupVisible(false), SETUP_MODAL_ANIM_MS);
      return () => window.clearTimeout(timeout);
    }
  }, [setupOpen, setupVisible]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.lang, lang);
  }, [lang]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.theme, theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.ollamaHost, ollamaHost);
  }, [ollamaHost]);

  useEffect(() => {
    syncOllamaHost();
  }, [ollamaHost]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.setupComplete, JSON.stringify(setupComplete));
  }, [setupComplete]);

  useEffect(() => {
    checkSetup();
  }, []);

  useEffect(() => {
    if (setupState !== "ready") {
      setSettingsOpen(false);
      setSetupOpen(true);
    } else if (!setupError && !setupPinned) {
      setSetupOpen(false);
    }
  }, [setupState, setupError, setupPinned]);

  useEffect(() => {
    setSourcesPage(0);
  }, [sourcesQuery, sourcesPageSize]);

  useEffect(() => {
    setFilesPage(0);
  }, [previewFilter, filesPageSize]);

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
    if (!activeSessionId) return;
    const exists = sessions.some((s) => s.id === activeSessionId);
    if (!exists) {
      setActiveSessionId("");
    }
  }, [activeSessionId, sessions]);


  useEffect(() => {
    setChatError(null);
  }, [activeSessionId]);

  useEffect(() => {
    if (view !== "chat") return;
    const el = chatLogRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [log.length, view]);


  async function loadModels() {
    setModelsBusy(true);
    setModelError(null);
    try {
      await syncOllamaHost();
      const res = (await invoke("list_models")) as string[];
      setModels(res);
      markOllamaOk();

      const embedCandidates = res.filter(isEmbeddingModel);
      const chatCandidates = res.filter((m) => !isEmbeddingModel(m));
      const defaultChat = setupDefaults.fast || setupDefaults.chat || DEFAULT_CHAT_MODEL;
      const defaultEmbed = setupDefaults.embed || DEFAULT_EMBED_MODEL;

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
      markOllamaError(err);
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
    let unlistenDelta: (() => void) | null = null;
    listen<string>("chat_delta", (event) => {
      const sessionId = streamSessionRef.current;
      if (!sessionId) return;
      setChatStreaming(true);
      setChatFinalized(false);
      updateLastAssistant(sessionId, (m) => ({ ...m, text: m.text + event.payload }));
    }).then((unlisten) => {
      unlistenDelta = unlisten;
    });
    return () => {
      unlistenDelta?.();
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
    if (!deferredPreviewFilter.trim()) return previewFiles;
    const q = deferredPreviewFilter.trim().toLowerCase();
    return previewFiles.filter((f) => f.path.toLowerCase().includes(q));
  }, [previewFiles, deferredPreviewFilter]);

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

  const filteredTargets = useMemo(() => {
    if (!deferredSourcesQuery.trim()) return targets;
    const q = deferredSourcesQuery.trim().toLowerCase();
    return targets.filter((tgt) => tgt.path.toLowerCase().includes(q));
  }, [targets, deferredSourcesQuery]);
  const sourcesPageCount = Math.max(1, Math.ceil(filteredTargets.length / sourcesPageSize));
  const sourcesPageSafe = Math.min(sourcesPage, sourcesPageCount - 1);
  const sourcesSliceStart = sourcesPageSafe * sourcesPageSize;
  const sourcesSliceEnd = Math.min(filteredTargets.length, sourcesSliceStart + sourcesPageSize);
  const pagedTargets = filteredTargets.slice(sourcesSliceStart, sourcesSliceEnd);
  const sourcesRange =
    filteredTargets.length === 0
      ? "0/0"
      : `${sourcesSliceStart + 1}-${sourcesSliceEnd} / ${filteredTargets.length}`;

  const filesPageCount = Math.max(1, Math.ceil(filteredFiles.length / filesPageSize));
  const filesPageSafe = Math.min(filesPage, filesPageCount - 1);
  const filesSliceStart = filesPageSafe * filesPageSize;
  const filesSliceEnd = Math.min(filteredFiles.length, filesSliceStart + filesPageSize);
  const pagedFiles = filteredFiles.slice(filesSliceStart, filesSliceEnd);
  const filesRange =
    filteredFiles.length === 0
      ? "0/0"
      : `${filesSliceStart + 1}-${filesSliceEnd} / ${filteredFiles.length}`;
  const isTargetsTab = sourcesTab === "targets";
  const searchValue = isTargetsTab ? sourcesQuery : previewFilter;
  const searchPlaceholder = isTargetsTab ? t.sourcesSearch : t.filterFiles;
  const searchDisabled = !isTargetsTab && previewBusy;
  const pageRange = isTargetsTab ? sourcesRange : filesRange;
  const pageSize = isTargetsTab ? sourcesPageSize : filesPageSize;
  const pagePrevDisabled = isTargetsTab ? sourcesPageSafe === 0 : filesPageSafe === 0;
  const pageNextDisabled = isTargetsTab
    ? sourcesPageSafe >= sourcesPageCount - 1
    : filesPageSafe >= filesPageCount - 1;
  const showIndexProgress = !!indexProgress;
  const statusHint = indexDone ? t.indexDone : indexing ? t.indexing : t.indexIdle;
  const progressStatus = indexProgress
    ? t.indexStatus[indexProgress.status as keyof typeof t.indexStatus] ?? indexProgress.status
    : "";
  const progressCount = indexProgress ? `${indexProgress.current}/${indexProgress.total}` : "";
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
  const showWatcher = !!watcherInfo;
  const watcherText = watcherInfo ? `${watcherLabel} | ${watcherInfo.watched}` : "";
  const showReindex = !!reindexInfo;
  const reindexText = reindexInfo ? `${reindexLabel} | ${reindexInfo.files.length}` : "";

  useEffect(() => {
    if (sourcesPage > sourcesPageCount - 1) {
      setSourcesPage(Math.max(0, sourcesPageCount - 1));
    }
  }, [sourcesPage, sourcesPageCount]);

  useEffect(() => {
    if (filesPage > filesPageCount - 1) {
      setFilesPage(Math.max(0, filesPageCount - 1));
    }
  }, [filesPage, filesPageCount]);

  const hasIndexable = useMemo(
    () => previewFiles.some((f) => f.status !== "indexed" && f.status !== "missing"),
    [previewFiles],
  );
  const canIndex = hasIndexable && !!embedModel && !indexing;

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
    setTargets((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (targetsLoaded) {
        const payload = next.map(({ path, kind, includeSubfolders }) => ({
          path,
          kind,
          includeSubfolders,
        }));
        invoke("prune_index", { targets: payload }).catch(() => {});
      }
      return next;
    });
  }

  function toggleSubfolders(id: string, value: boolean) {
    setTargets((prev) =>
      prev.map((t) => (t.id === id ? { ...t, includeSubfolders: value } : t)),
    );
  }

  function appendMessage(sessionId: string, message: ChatMessage) {
    setSessions((prev) => {
      const idx = prev.findIndex((session) => session.id === sessionId);
      if (idx === -1) {
        const messages = [message];
        const session: ChatSession = {
          id: sessionId,
          title: deriveTitle(messages, t.newChat),
          createdAt: Date.now(),
          messages,
        };
        return [session, ...prev];
      }
      const session = prev[idx];
      const messages = [...session.messages, message];
      const title = deriveTitle(messages, session.title || t.newChat);
      const next = [...prev];
      next[idx] = { ...session, messages, title };
      return next;
    });
  }

  function updateLastAssistant(sessionId: string, updater: (message: ChatMessage) => ChatMessage) {
    setSessions((prev) => {
      const idx = prev.findIndex((session) => session.id === sessionId);
      if (idx === -1) return prev;
      const session = prev[idx];
      if (session.messages.length === 0) return prev;
      const lastIdx = session.messages.length - 1;
      const last = session.messages[lastIdx];
      if (last.role !== "assistant") return prev;
      const messages = [...session.messages];
      messages[lastIdx] = updater(last);
      const next = [...prev];
      next[idx] = { ...session, messages };
      return next;
    });
  }

  async function doIndex() {
    if (!embedModel || targets.length === 0 || !hasIndexable) return;
    setIndexError(null);
    setIndexDone(false);
    setIndexing(true);
    try {
      await syncOllamaHost();
      const payload = targets.map(({ path, kind, includeSubfolders }) => ({
        path,
        kind,
        includeSubfolders,
      }));
      await invoke("start_index", {
        targets: payload,
        embedModel,
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
      await syncOllamaHost();
      await invoke("reindex_files", {
        files: [path],
        embedModel,
        settings: indexSettings,
      });
    } catch (err) {
      setIndexError(String(err));
      setIndexing(false);
    }
  }

  async function send() {
    const query = q.trim();
    if (!query || !chatModel || !embedModel || chatBusy) return;
    const hasActive = activeSessionId && sessions.some((s) => s.id === activeSessionId);
    const sessionId = hasActive ? activeSessionId : newId();
    if (!hasActive) {
      setActiveSessionId(sessionId);
    }
    setQ("");
    setChatError(null);
    setChatStreaming(false);
    setChatFinalized(false);
    appendMessage(sessionId, { role: "user", text: query });
    appendMessage(sessionId, { role: "assistant", text: "" });
    streamSessionRef.current = sessionId;
    setChatBusy(true);
    try {
      await syncOllamaHost();
      const resp = (await invoke("chat_stream", {
        question: query,
        llmModel: chatModel,
        embedModel,
        settings: retrievalSettings,
      })) as ChatResponse;
      updateLastAssistant(sessionId, (m) => ({ ...m, text: resp.answer, sources: resp.sources }));
      setChatFinalized(true);
      markOllamaOk();
    } catch (err) {
      setChatError(String(err));
      setChatStreaming(false);
      setChatFinalized(false);
      markOllamaError(err);
      setSessions((prev) => {
        const idx = prev.findIndex((session) => session.id === sessionId);
        if (idx === -1) return prev;
        const session = prev[idx];
        if (session.messages.length === 0) return prev;
        const lastIdx = session.messages.length - 1;
        const last = session.messages[lastIdx];
        if (last.role !== "assistant" || last.text.trim() !== "") return prev;
        const messages = session.messages.slice(0, -1);
        const next = [...prev];
        next[idx] = { ...session, messages };
        return next;
      });
    } finally {
      streamSessionRef.current = null;
      setChatStreaming(false);
      setChatBusy(false);
    }
  }

  function createNewChat() {
    setActiveSessionId("");
    setQ("");
    setChatError(null);
    setChatStreaming(false);
    setChatFinalized(false);
    setView("chat");
  }

  function deleteChat(id: string) {
    setDeleteDialog({ open: true, sessionId: id });
  }

  function cancelDeleteChat() {
    setDeleteDialog({ open: false, sessionId: null });
  }

  function confirmDeleteChat() {
    const id = deleteDialog.sessionId;
    if (!id) {
      cancelDeleteChat();
      return;
    }
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (id === activeSessionId) {
        if (next.length > 0) {
          const nextSorted = [...next].sort((a, b) => b.createdAt - a.createdAt);
          setActiveSessionId(nextSorted[0].id);
        } else {
          setActiveSessionId("");
        }
      }
      return next;
    });
    setDeleteDialog({ open: false, sessionId: null });
  }

  function prevPage() {
    if (sourcesTab === "targets") {
      setSourcesPage((p) => Math.max(0, p - 1));
    } else {
      setFilesPage((p) => Math.max(0, p - 1));
    }
  }

  function nextPage() {
    if (sourcesTab === "targets") {
      setSourcesPage((p) => Math.min(sourcesPageCount - 1, p + 1));
    } else {
      setFilesPage((p) => Math.min(filesPageCount - 1, p + 1));
    }
  }

  function updatePageSize(value: number) {
    if (sourcesTab === "targets") {
      setSourcesPageSize(value);
    } else {
      setFilesPageSize(value);
    }
  }

  const activeSessions = useMemo(() => {
    return [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  }, [sessions]);

  const setupStatusText =
    setupState === "checking"
      ? t.setupChecking
      : setupState === "running"
        ? t.setupRunning
        : !ollamaRunning
          ? t.ollamaNotRunning
          : setupMessage || t.setupReady;
  const modelsDisabled = modelsBusy || !ollamaRunning;
  const advancedToggleLabel = advancedOpen ? t.advancedToggleHide : t.advancedToggleShow;
  const chatStatus = chatBusy
    ? { key: "busy", label: t.chatThinking, icon: Icons.refresh }
    : chatError
      ? { key: "error", label: t.chatError, icon: Icons.alert }
      : { key: "ready", label: t.chatReady, icon: Icons.check };
  const chatStatusTitle = chatError ? `${t.chatError}: ${chatError}` : chatStatus.label;
  const streamStatus = chatStreaming
    ? { key: "streaming", label: t.chatStreaming }
    : chatFinalized
      ? { key: "finalized", label: t.chatFinalized }
      : null;
  const healthTitle =
    ollamaHealth.status === "error"
      ? ollamaHealth.message || t.ollamaHealthError
      : t.ollamaHealthOk;
  const showSetupDownload = setupState === "running";
  const setupDownloadLabel = setupMessage || t.setupRunning;
  const deleteSession = deleteDialog.sessionId
    ? sessions.find((s) => s.id === deleteDialog.sessionId) ?? null
    : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            {Icons.chat}
          </div>
          <div>
            <div className="brand-title">{t.appTitle}</div>
            <div className="brand-subtitle">{t.appSubtitle}</div>
          </div>
        </div>
        <div className="topbar-actions">
          {(ollamaRunning || ollamaHealth.status === "error") && (
            <div className="health-row health-compact" title={healthTitle}>
              <span className="health-label">{t.ollamaHealth}</span>
              <span className={`status-pill ${ollamaHealth.status === "ok" ? "ready" : "error"}`}>
                <span className="status-text">
                  {ollamaHealth.status === "ok" ? t.ollamaHealthOk : t.ollamaHealthError}
                </span>
              </span>
            </div>
          )}
          {showSetupDownload && (
            <div className="download-status">
              <div className="status-pill busy" title={setupDownloadLabel}>
                {Icons.refresh}
                <span className="status-text truncate">{setupDownloadLabel}</span>
              </div>
              <div className="download-bar" aria-hidden="true" />
            </div>
          )}
        </div>
      </header>

      <div className="layout">
        <nav className="rail">
          <button
            className={`rail-button ${view === "chat" ? "active" : ""}`}
            onClick={() => setView("chat")}
            aria-label={t.navChat}
            title={t.navChat}
          >
            {Icons.chat}
            <span className="label">{t.navChat}</span>
          </button>
          <button
            className={`rail-button ${view === "sources" ? "active" : ""}`}
            onClick={() => setView("sources")}
            aria-label={t.navSources}
            title={t.navSources}
          >
            {Icons.folder}
            <span className="label">{t.navSources}</span>
          </button>
          <button
            className={`rail-button ${view === "history" ? "active" : ""}`}
            onClick={() => setView("history")}
            aria-label={t.navHistory}
            title={t.navHistory}
          >
            {Icons.history}
            <span className="label">{t.navHistory}</span>
          </button>
          <button
            className="rail-button"
            onClick={() => setSettingsOpen(true)}
            aria-label={t.navSettings}
            title={t.navSettings}
          >
            {Icons.gear}
            <span className="label">{t.navSettings}</span>
          </button>
        </nav>
        <div className="content">
          {view === "chat" && (
            <section className="card chat-card">
          <div className="card-header">
            <div className="title-with-icon">
              {Icons.chat}
              <h2>{t.chatTitle}</h2>
            </div>
            <div className="chat-meta">
              <div className="model-chips">
                <span className="chip" title={chatModel || "-"}>
                  {Icons.chat}
                  <span className="chip-text truncate">{chatModel || "-"}</span>
                </span>
                <span className="chip" title={embedModel || "-"}>
                  {Icons.file}
                  <span className="chip-text truncate">{embedModel || "-"}</span>
                </span>
              </div>
              <div
                className={`status-pill ${chatStatus.key}`}
                title={chatStatusTitle}
                role="status"
                aria-live="polite"
              >
                {chatStatus.icon}
                <span className="status-text">{chatStatus.label}</span>
              </div>
              {streamStatus && (
                <div className={`status-pill ${streamStatus.key}`} title={streamStatus.label}>
                  <span className="status-text">{streamStatus.label}</span>
                </div>
              )}
              <button
                className="icon-button ghost icon-only"
                onClick={createNewChat}
                title={t.newChat}
                aria-label={t.newChat}
              >
                {Icons.plus}
                <span className="label">{t.newChat}</span>
              </button>
            </div>
          </div>
          <div className="chat-log" aria-busy={chatBusy} ref={chatLogRef}>
            {log.length === 0 && !chatBusy && (
              <div className="empty">{t.emptyChat}</div>
            )}
            {log.map((m, i) => (
              <div className={`message ${m.role}`} key={i}>
                <div className="message-role">
                  {m.role === "user" ? Icons.user : Icons.chat}
                  <span>{m.role === "user" ? t.you : t.assistant}</span>
                </div>
                <div className="message-text">{m.text}</div>
                {m.sources && m.sources.length > 0 && (
                  <div className="sources">
                    <div className="sources-title">{t.sourcesLabel}</div>
                    {m.sources.map((s, idx) => (
                      <div className="source-card" key={`${s.file_path}-${idx}`}>
                        <div className="source-meta">
                          <span className="badge neutral">#{idx + 1}</span>
                          <span className="source-path truncate" title={s.file_path}>{s.file_path}</span>
                          <span className="source-score">p. {s.page + 1} | {s.distance.toFixed(4)}</span>
                        </div>
                        <div className="source-snippet">{s.snippet}</div>
                        <div className="source-actions">
                          <button className="icon-button ghost icon-only" onClick={() => openPath(s.file_path)} title={t.openFile} aria-label={t.openFile}>
                            {Icons.file}
                            <span className="label">{t.openFile}</span>
                          </button>
                          <button className="icon-button ghost icon-only" onClick={() => revealItemInDir(s.file_path)} title={t.reveal} aria-label={t.reveal}>
                            {Icons.folder}
                            <span className="label">{t.reveal}</span>
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
            <button
              className={`icon-button primary icon-only ${chatBusy ? "busy" : ""}`}
              onClick={send}
              disabled={chatBusy || !chatModel || !embedModel}
              aria-label={t.send}
              title={t.send}
            >
              {chatBusy ? Icons.refresh : Icons.send}
              <span className="label">{t.send}</span>
            </button>
            <textarea
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={t.askPlaceholder}
              disabled={chatBusy}
              rows={1}
            />
          </div>
        </section>
          )}

          {view === "sources" && (
            <div className="stack">
          <section className="card sources-card">
            <div className="panel-header">
              <div className="title-with-icon">
                {Icons.folder}
                <h2>{t.sourcesTitle}</h2>
              </div>
              <div className="panel-tabs">
                <button
                  className={`tab-button ${isTargetsTab ? "active" : ""}`}
                  onClick={() => setSourcesTab("targets")}
                  aria-label={t.sourcesTitle}
                  title={t.sourcesTitle}
                >
                  {Icons.folder}
                  <span className="label">{t.sourcesTitle}</span>
                </button>
                <button
                  className={`tab-button ${!isTargetsTab ? "active" : ""}`}
                  onClick={() => setSourcesTab("files")}
                  aria-label={t.filesTitle}
                  title={t.filesTitle}
                >
                  {Icons.file}
                  <span className="label">{t.filesTitle}</span>
                </button>
              </div>
            </div>

            <div className="panel-toolbar">
              <div className="search-row">
                {Icons.search}
                <input
                  value={searchValue}
                  onChange={(e) =>
                    isTargetsTab ? setSourcesQuery(e.target.value) : setPreviewFilter(e.target.value)
                  }
                  placeholder={searchPlaceholder}
                  disabled={searchDisabled}
                />
              </div>
              <div className="toolbar-actions">
                {isTargetsTab && (
                  <>
                    <button className="icon-button ghost icon-only" onClick={addFolders} title={t.addFolders} aria-label={t.addFolders}>
                      {Icons.folder}
                      <span className="label">{t.addFolders}</span>
                    </button>
                    <button className="icon-button ghost icon-only" onClick={addFiles} title={t.addFiles} aria-label={t.addFiles}>
                      {Icons.file}
                      <span className="label">{t.addFiles}</span>
                    </button>
                  </>
                )}
                <button
                  className="icon-button primary icon-only"
                  onClick={doIndex}
                  disabled={!canIndex}
                  aria-label={t.indexNow}
                  title={t.indexNow}
                >
                  {indexing ? Icons.refresh : Icons.play}
                  <span className="label">{indexing ? t.indexing : t.indexNow}</span>
                </button>
              </div>
            </div>

            <div className="stat-list">
              {isTargetsTab ? (
                <div className="stat-pill" title={`${t.sourcesTitle}: ${filteredTargets.length}`}>
                  {Icons.folder}
                  <span>{filteredTargets.length}</span>
                </div>
              ) : (
                <>
                  <div className="stat-pill" title={`${t.filesSummary}: ${fileCounts.total}`}>
                    {Icons.list}
                    <span>{fileCounts.total}</span>
                  </div>
                  <div className="stat-pill" title={`${t.filesNew}: ${fileCounts.new}`}>
                    {Icons.plus}
                    <span>{fileCounts.new}</span>
                  </div>
                  <div className="stat-pill" title={`${t.filesIndexed}: ${fileCounts.indexed}`}>
                    {Icons.check}
                    <span>{fileCounts.indexed}</span>
                  </div>
                  <div className="stat-pill" title={`${t.filesChanged}: ${fileCounts.changed}`}>
                    {Icons.refresh}
                    <span>{fileCounts.changed}</span>
                  </div>
                  <div className="stat-pill" title={`${t.filesMissing}: ${fileCounts.missing}`}>
                    {Icons.alert}
                    <span>{fileCounts.missing}</span>
                  </div>
                </>
              )}
            </div>

            {isTargetsTab ? (
              <>
                {filteredTargets.length === 0 && <div className="empty">{t.targetsEmpty}</div>}
                {filteredTargets.length > 0 && (
                  <div className="target-list">
                    {pagedTargets.map((tgt) => (
                      <div className="target-row" key={tgt.id}>
                        <div className="target-main">
                          <div className="target-path" title={tgt.path}>
                            {tgt.kind === "folder" ? Icons.folder : Icons.file}
                            <span className="truncate">{tgt.path}</span>
                          </div>
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
                        <button
                          className="icon-button ghost icon-only"
                          onClick={() => removeTarget(tgt.id)}
                          aria-label={t.remove}
                          title={t.remove}
                        >
                          {Icons.trash}
                          <span className="label">{t.remove}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                {previewBusy && <div className="hint">{t.indexing}</div>}
                {!previewBusy && filteredFiles.length === 0 && (
                  <div className="empty">{t.filesEmpty}</div>
                )}
                <div className="file-list">
                  {pagedFiles.map((file) => {
                    const statusLabel = t.fileStatus[file.status as keyof typeof t.fileStatus] ?? file.status;
                    const badgeClass =
                      file.status === "indexed"
                        ? "badge good"
                        : file.status === "changed"
                          ? "badge warn"
                          : file.status === "missing"
                            ? "badge neutral"
                            : file.status === "error"
                              ? "badge danger"
                              : "badge info";
                    const statusIcon =
                      file.status === "indexed"
                        ? Icons.check
                        : file.status === "changed"
                          ? Icons.refresh
                          : file.status === "missing"
                            ? Icons.alert
                            : file.status === "error"
                              ? Icons.alert
                              : Icons.plus;
                    const sizeLabel = formatSize(file.size);
                    return (
                      <div className="file-row" key={file.path}>
                        <div className="file-main">
                          <div className="file-path" title={file.path}>
                            {Icons.file}
                            <span className="truncate">{file.path}</span>
                          </div>
                          <div className="file-meta">
                            {file.kind.toUpperCase()}
                            {sizeLabel ? ` | ${sizeLabel}` : ""}
                          </div>
                        </div>
                        <div className="file-actions">
                          <span className={badgeClass} title={statusLabel} aria-label={statusLabel}>
                            {statusIcon}
                          </span>
                          {file.status !== "missing" && (
                            <button
                              className="icon-button ghost icon-only"
                              onClick={() => reindexFile(file.path)}
                              title={t.refreshFile}
                              aria-label={t.refreshFile}
                            >
                              {Icons.refresh}
                              <span className="label">{t.refreshFile}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            <div className="pager">
              <button
                className="icon-button ghost icon-only"
                onClick={prevPage}
                disabled={pagePrevDisabled}
                aria-label={t.prev}
                title={t.prev}
              >
                {Icons.arrowLeft}
                <span className="label">{t.prev}</span>
              </button>
              <span className="pager-range">{pageRange}</span>
              <button
                className="icon-button ghost icon-only"
                onClick={nextPage}
                disabled={pageNextDisabled}
                aria-label={t.next}
                title={t.next}
              >
                {Icons.arrowRight}
                <span className="label">{t.next}</span>
              </button>
              <label className="pager-size" title={t.perPage}>
                {Icons.list}
                <select value={pageSize} onChange={(e) => updatePageSize(Number(e.target.value))}>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                </select>
              </label>
            </div>

            <div className="status compact">
              <div className="status-label">{t.progress}</div>
              <div className={`status-row ${showIndexProgress ? "" : "is-hidden"}`} aria-hidden={!showIndexProgress}>
                <span className="badge neutral">{showIndexProgress ? progressStatus : t.indexing}</span>
                <span>{showIndexProgress ? progressCount : ""}</span>
              </div>
              <div
                className={`progress-bar ${showIndexProgress ? "" : "is-hidden"}`}
                role="progressbar"
                aria-hidden={!showIndexProgress}
                aria-valuenow={indexProgress?.current ?? 0}
                aria-valuemin={0}
                aria-valuemax={indexProgress?.total ?? 0}
              >
                <div
                  className="progress-bar-fill"
                  style={{ width: `${Math.min(100, Math.round(((indexProgress?.current ?? 0) / Math.max(1, indexProgress?.total ?? 0)) * 100))}%` }}
                />
              </div>
              <div className={`hint ${showIndexProgress ? "is-hidden" : ""}`} aria-hidden={showIndexProgress}>
                {statusHint}
              </div>
              {indexError && (
                <div className="error">
                  {t.indexError}: {indexError}
                </div>
              )}
              <div
                className={`file-path truncate ${showIndexProgress ? "" : "is-hidden"}`}
                aria-hidden={!showIndexProgress}
                title={indexProgress?.file ?? ""}
              >
                {indexProgress?.file ?? ""}
              </div>
              <div className={`status-row ${showWatcher ? "" : "is-hidden"}`} aria-hidden={!showWatcher}>
                <span className="status-label">{t.watcherStatus}</span>
                <span>{showWatcher ? watcherText : ""}</span>
              </div>
              <div className={`status-row ${showReindex ? "" : "is-hidden"}`} aria-hidden={!showReindex}>
                <span className="status-label">{t.reindexStatus}</span>
                <span>{showReindex ? reindexText : ""}</span>
              </div>
            </div>
          </section>

            </div>
          )}

          {view === "history" && (
            <section className="card history-card">
              <div className="card-header">
                <div className="title-with-icon">
                  {Icons.history}
                  <h2>{t.historyTitle}</h2>
                </div>
                <button className="icon-button ghost icon-only" onClick={createNewChat} title={t.newChat} aria-label={t.newChat}>
                  {Icons.plus}
                  <span className="label">{t.newChat}</span>
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
                      <button
                        className="icon-button ghost icon-only"
                        onClick={() => {
                          setActiveSessionId(session.id);
                          setView("chat");
                        }}
                        title={t.loadChat}
                        aria-label={t.loadChat}
                      >
                        {Icons.load}
                        <span className="label">{t.loadChat}</span>
                      </button>
                      <button
                        className="icon-button ghost icon-only"
                        onClick={() => deleteChat(session.id)}
                        title={t.deleteChat}
                        aria-label={t.deleteChat}
                      >
                        {Icons.trash}
                        <span className="label">{t.deleteChat}</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {settingsOpen && (
        <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label={t.settingsTitle} onClick={() => setSettingsOpen(false)}>
          <section className="settings-panel" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <div>
                <h2>{t.settingsTitle}</h2>
                <div className="hint">{t.settingsHint}</div>
              </div>
              <button
                className="icon-button ghost icon-only"
                onClick={() => setSettingsOpen(false)}
                aria-label={t.close}
                title={t.close}
              >
                {Icons.close}
                <span className="label">{t.close}</span>
              </button>
            </div>

            <div className="settings-section">
              <div className="settings-title">{t.settingsGeneral}</div>
              <div className="settings-grid">
                <div className="select-field">
                  <div className="label-with-help">
                    <label htmlFor="settings-language">{t.language}</label>
                    <HelpIcon text={t.languageHelp} />
                  </div>
                  <select id="settings-language" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
                    <option value="pl">PL</option>
                    <option value="en">EN</option>
                  </select>
                </div>
                <div className="select-field">
                  <div className="label-with-help">
                    <label htmlFor="settings-theme">{t.theme}</label>
                    <HelpIcon text={t.themeHelp} />
                  </div>
                  <select id="settings-theme" value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
                    <option value="light">{t.themeLight}</option>
                    <option value="dark">{t.themeDark}</option>
                  </select>
                </div>
              </div>
              <div className="settings-actions">
                <button
                  className="icon-button ghost icon-only"
                  onClick={openSetupWizard}
                  aria-label={t.reRunSetup}
                  title={t.reRunSetup}
                >
                  {Icons.refresh}
                  <span className="label">{t.reRunSetup}</span>
                </button>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-row">
                <div className="settings-title">{t.modelsTitle}</div>
                <button
                  className="icon-button ghost icon-only"
                  onClick={loadModels}
                  disabled={modelsBusy || !ollamaRunning}
                  aria-label={t.refreshModels}
                  title={t.refreshModels}
                >
                  {Icons.refresh}
                  <span className="label">{t.refreshModels}</span>
                </button>
              </div>
              <div className="hint">{t.modelHint}</div>
              {!ollamaRunning && <div className="warning">{t.modelsUnavailable}</div>}
              {ollamaRunning && (
                <div className="health-row">
                  <span className="health-label">{t.ollamaHealth}</span>
                  <span className={`status-pill ${ollamaHealth.status === "ok" ? "ready" : "error"}`}>
                    <span className="status-text">
                      {ollamaHealth.status === "ok" ? t.ollamaHealthOk : t.ollamaHealthError}
                    </span>
                  </span>
                  {ollamaHealth.status === "error" && ollamaHealth.message && (
                    <span className="health-detail">{ollamaHealth.message}</span>
                  )}
                </div>
              )}
              <div className="field">
                <div className="label-with-help">
                  <label htmlFor="settings-chat-model">{t.chatModel}</label>
                  <HelpIcon text={t.chatModelHelp} />
                </div>
                <select
                  id="settings-chat-model"
                  value={chatModel}
                  onChange={(e) => {
                    setChatModel(e.target.value);
                    setChatTouched(true);
                  }}
                  disabled={modelsDisabled}
                >
                  {models.map((m) => (
                    <option value={m} key={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <div className="label-with-help">
                  <label htmlFor="settings-embed-model">{t.embedModel}</label>
                  <HelpIcon text={t.embedModelHelp} />
                </div>
                <select
                  id="settings-embed-model"
                  value={embedModel}
                  onChange={(e) => {
                    setEmbedModel(e.target.value);
                    setEmbedTouched(true);
                  }}
                  disabled={modelsDisabled}
                >
                  {models.map((m) => (
                    <option value={m} key={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              {modelError && <div className="error">{t.modelsError}: {modelError}</div>}
              {!modelError && models.length === 0 && !modelsBusy && ollamaRunning && (
                <div className="empty">{t.modelsEmpty}</div>
              )}
            </div>

            <div className="settings-section">
              <div className="settings-row">
                <div className="settings-title">{t.settingsSearch}</div>
                <button className="ghost small" onClick={() => setAdvancedOpen((v) => !v)}>
                  {advancedToggleLabel}
                </button>
              </div>
              <div className="field inline">
                <div className="label-with-help">
                  <label htmlFor="settings-topk">{t.topK}</label>
                  <HelpIcon text={t.topKHelp} />
                </div>
                <input
                  id="settings-topk"
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
                  <div className="toggle-with-help">
                    <label className="toggle" htmlFor="settings-use-mmr">
                      <input
                        id="settings-use-mmr"
                        type="checkbox"
                        checked={retrievalSettings.useMmr}
                        onChange={(e) => setRetrievalSettings((s) => ({ ...s, useMmr: e.target.checked }))}
                      />
                      <span>{t.useMmr}</span>
                    </label>
                    <HelpIcon text={t.useMmrHelp} />
                  </div>
                  <div className="field">
                    <div className="label-with-help">
                      <label htmlFor="settings-mmr-lambda">{t.mmrLambda}</label>
                      <HelpIcon text={t.mmrLambdaHelp} />
                    </div>
                    <input
                      id="settings-mmr-lambda"
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
                    <div className="label-with-help">
                      <label htmlFor="settings-mmr-candidates">{t.mmrCandidates}</label>
                      <HelpIcon text={t.mmrCandidatesHelp} />
                    </div>
                    <input
                      id="settings-mmr-candidates"
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
                    <div className="label-with-help">
                      <label htmlFor="settings-max-distance">{t.maxDistance}</label>
                      <HelpIcon text={t.maxDistanceHelp} />
                    </div>
                    <input
                      id="settings-max-distance"
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
            </div>

            <div className="settings-section">
              <div className="settings-title">{t.settingsIndexing}</div>
              <div className="advanced-grid">
                <div className="field">
                  <div className="label-with-help">
                    <label htmlFor="settings-chunk-size">{t.chunkSize}</label>
                    <HelpIcon text={t.chunkSizeHelp} />
                  </div>
                  <input
                    id="settings-chunk-size"
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
                  <div className="label-with-help">
                    <label htmlFor="settings-chunk-overlap">{t.chunkOverlap}</label>
                    <HelpIcon text={t.chunkOverlapHelp} />
                  </div>
                  <input
                    id="settings-chunk-overlap"
                    type="number"
                    min={0}
                    max={1000}
                    value={indexSettings.chunkOverlap}
                    onChange={(e) =>
                      setIndexSettings((s) => ({ ...s, chunkOverlap: Number(e.target.value) }))
                    }
                  />
                </div>
                <div className="toggle-with-help">
                  <label className="toggle" htmlFor="settings-ocr-enabled">
                    <input
                      id="settings-ocr-enabled"
                      type="checkbox"
                      checked={indexSettings.ocrEnabled}
                      onChange={(e) =>
                        setIndexSettings((s) => ({ ...s, ocrEnabled: e.target.checked }))
                      }
                    />
                    <span>{t.ocrEnabled}</span>
                  </label>
                  <HelpIcon text={t.ocrEnabledHelp} />
                </div>
                <div className="field">
                  <div className="label-with-help">
                    <label htmlFor="settings-ocr-lang">{t.ocrLang}</label>
                    <HelpIcon text={t.ocrLangHelp} />
                  </div>
                  <input
                    id="settings-ocr-lang"
                    value={indexSettings.ocrLang}
                    onChange={(e) =>
                      setIndexSettings((s) => ({ ...s, ocrLang: e.target.value }))
                    }
                  />
                </div>
                <div className="field">
                  <div className="label-with-help">
                    <label htmlFor="settings-ocr-min-chars">{t.ocrMinChars}</label>
                    <HelpIcon text={t.ocrMinCharsHelp} />
                  </div>
                  <input
                    id="settings-ocr-min-chars"
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
                  <div className="label-with-help">
                    <label htmlFor="settings-ocr-dpi">{t.ocrDpi}</label>
                    <HelpIcon text={t.ocrDpiHelp} />
                  </div>
                  <input
                    id="settings-ocr-dpi"
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
            </div>
          </section>
        </div>
      )}

      {setupVisible && (
        <div
          className={`modal-backdrop ${setupActive ? "is-open" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={t.setupTitle}
        >
          <section className="modal">
            <div className="modal-header">
              <div>
                <h2>{t.setupTitle}</h2>
                <div className="hint">{t.setupSubtitle}</div>
              </div>
              <button
                className="icon-button ghost icon-only"
                onClick={() => {
                  setSetupPinned(false);
                  setSetupOpen(false);
                }}
                aria-label={t.setupClose}
                title={t.setupClose}
              >
                {Icons.close}
                <span className="label">{t.setupClose}</span>
              </button>
            </div>

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

            <div className="modal-grid">
              <div className="modal-panel">
                <div className="meta">{t.setupHost}</div>
                <input
                  type="url"
                  value={ollamaHost}
                  onChange={(e) => setOllamaHost(e.target.value)}
                  placeholder={DEFAULT_OLLAMA_HOST}
                />
                <div className="hint">{t.setupHostHint}</div>
              </div>
              <div className="modal-panel">
                <div className="meta">{t.setupModelsTitle}</div>
                <div className="field">
                  <label>{t.chatModel}</label>
                  <select
                    value={chatModel}
                    onChange={(e) => {
                      setChatModel(e.target.value);
                      setChatTouched(true);
                    }}
                    disabled={modelsDisabled}
                  >
                    {models.map((m) => (
                      <option value={m} key={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>{t.embedModel}</label>
                  <select
                    value={embedModel}
                    onChange={(e) => {
                      setEmbedModel(e.target.value);
                      setEmbedTouched(true);
                    }}
                    disabled={modelsDisabled}
                  >
                    {models.map((m) => (
                      <option value={m} key={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="modal-panel">
                <div className="meta">{t.setupSourcesTitle}</div>
                <div className="hint">{t.setupSourcesHint}</div>
                <div className="card-actions">
                  <button
                    className="icon-button ghost icon-only"
                    onClick={addFolders}
                    aria-label={t.addFolders}
                    title={t.addFolders}
                  >
                    {Icons.folder}
                    <span className="label">{t.addFolders}</span>
                  </button>
                  <button
                    className="icon-button ghost icon-only"
                    onClick={addFiles}
                    aria-label={t.addFiles}
                    title={t.addFiles}
                  >
                    {Icons.file}
                    <span className="label">{t.addFiles}</span>
                  </button>
                </div>
                {targets.length === 0 && <div className="empty small">{t.targetsEmpty}</div>}
                {targets.length > 0 && (
                  <div className="mini-list">
                    {targets.slice(0, 4).map((tgt) => (
                      <div className="mini-row" key={tgt.id}>
                        <span className="mini-label">{tgt.kind === "folder" ? t.folderLabel : t.fileLabel}</span>
                        <span className="mini-path truncate" title={tgt.path}>{tgt.path}</span>
                      </div>
                    ))}
                    {targets.length > 4 && (
                      <div className="hint">+{targets.length - 4}</div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="setup-models">
              <div className="meta">{t.requiredModels}</div>
              <div className="setup-chips">
                {[setupDefaults.chat, setupDefaults.fast, setupDefaults.embed].map((model) => (
                  <span className="badge neutral" key={model}>{model}</span>
                ))}
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
              <button
                className="icon-button ghost"
                onClick={() => openPath(OLLAMA_URL)}
                disabled={setupState === "running"}
              >
                {Icons.download}
                <span>{t.installOllama}</span>
              </button>
              <button
                className="icon-button primary"
                onClick={() => checkSetup()}
                disabled={setupState === "running"}
              >
                {Icons.refresh}
                <span>{t.retry}</span>
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
      )}

      {deleteDialog.open && (
        <div
          className="confirm-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={t.deleteTitle}
          onClick={cancelDeleteChat}
        >
          <section className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-header">
              <div className="title-with-icon">
                {Icons.trash}
                <h2>{t.deleteTitle}</h2>
              </div>
              <button
                className="icon-button ghost icon-only"
                onClick={cancelDeleteChat}
                aria-label={t.close}
                title={t.close}
              >
                {Icons.close}
                <span className="label">{t.close}</span>
              </button>
            </div>
            <div className="confirm-body">
              <div className="confirm-message">{t.confirmDeleteChat}</div>
              {deleteSession && (
                <div className="confirm-item truncate" title={deleteSession.title || t.newChat}>
                  {deleteSession.title || t.newChat}
                </div>
              )}
            </div>
            <div className="confirm-actions">
              <button className="ghost" onClick={cancelDeleteChat}>
                {t.cancel}
              </button>
              <button className="primary danger" onClick={confirmDeleteChat}>
                {t.deleteChat}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
