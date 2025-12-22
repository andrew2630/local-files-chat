# Local Files Chat

Lokalna aplikacja desktopowa (Tauri + React) do szybkiego przeszukiwania tysięcy plików PDF i rozmowy z dokumentami **bez żadnych płatnych usług**. Indeksowanie i wyszukiwanie odbywa się lokalnie, a LLM/embeddingi są serwowane przez **Ollama**.

## Co aplikacja robi

- **Indeksuje foldery z PDF** (rekurencyjnie) i zapisuje dane w lokalnym SQLite.
- **Buduje embeddingi** (Ollama `/api/embed`) i zapisuje je do `sqlite-vec` (KNN).
- **Zadajesz pytania** → aplikacja wyszukuje najbardziej podobne fragmenty i wysyła kontekst do LLM (Ollama `/api/chat`).
- **Zwraca odpowiedź oraz źródła** (ścieżka pliku, strona, snippet).
- **Pozwala otworzyć PDF** lub ujawnić plik w Explorerze.

## Wymagania

- **Ollama** działające lokalnie: https://ollama.com
- Modele:
  - Chat: `llama3.1:8b` (lub inny)
  - Embedding: `qwen3-embedding` (lub inny)
- **SQLite-vec DLL** (Windows x64) jako zasób aplikacji.

### Pobranie modeli (PowerShell)

```powershell
ollama pull llama3.1:8b
ollama pull qwen3-embedding
```

### Test embeddingów (PowerShell)

```powershell
$body = @{ model="qwen3-embedding"; input="test" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:11434/api/embed -ContentType "application/json" -Body $body
```

## SQLite-vec (DLL)

1. Pobierz `sqlite-vec` (Windows x86_64) z releases: https://github.com/asg017/sqlite-vec
2. Umieść plik jako:

```
src-tauri/resources/vec0.dll
```

Plik jest bundlowany jako resource i ładowany w runtime przez `rusqlite` z włączonym `load_extension`.

## Uruchomienie (dev)

```bash
npm install
npm run dev
cargo tauri dev
```

## Build instalatora

```bash
cargo tauri build
```

W konfiguracji Tauri ustawiony jest **offline installer** dla WebView2:

```
bundle.windows.webviewInstallMode.type = "offlineInstaller"
```

## Jak działa indeksowanie

1. Wybierz folder(y) w panelu bocznym.
2. Kliknij **Index now**.
3. Aplikacja przechodzi po PDF-ach, wyciąga tekst i tnie go na fragmenty.
4. Dla każdego fragmentu tworzy embedding i zapisuje do SQLite + `vec0`.

**Uwaga:** PDF-y bez warstwy tekstowej (skany) będą miały puste wyniki. OCR może być dodany jako opcja później.

## Zmiana modelu embeddingów

Wymiar embeddingów jest zapisywany w bazie. Jeśli zmienisz model (a więc i wymiar), aplikacja automatycznie czyści indeks i buduje go od nowa.

## Struktura projektu

- `src/App.tsx` — UI czatu i indeksowania.
- `src-tauri/src/library.rs` — logika RAG: indeksowanie, wektory, KNN, prompt.
- `src-tauri/src/ollama.rs` — klient do Ollama (`/api/embed`, `/api/chat`).
- `src-tauri/src/lib.rs` — komendy Tauri (`start_index`, `chat`).
- `src-tauri/tauri.conf.json` — bundling zasobów i ustawienia instalatora.

## Produkcyjne uwagi

- Indeksowanie jest wykonywane w tle, a postęp raportowany eventami `index_progress`.
- Dla dużych kolekcji PDF rekomendowane jest SSD i większy RAM.
- Jeśli zmienisz ścieżki lub usuniesz pliki, indeks automatycznie odświeży dane przy kolejnym `Index now`.
