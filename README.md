# Local Files Chat

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS-4C4C4C)
![Tauri](https://img.shields.io/badge/Tauri-1.x-24C8DB?logo=tauri&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![SQLite](https://img.shields.io/badge/SQLite-sqlite--vec-003B57?logo=sqlite&logoColor=white)
![Ollama](https://img.shields.io/badge/Ollama-local-000000)

PL: Lokalna aplikacja desktopowa (Tauri + React) do rozmów z dokumentami offline. Indeksowanie i wyszukiwanie działają lokalnie w SQLite + sqlite-vec, a modele uruchamiane są przez lokalną instancję Ollama.
EN: Local desktop app (Tauri + React) for offline document chat. Indexing and retrieval run locally in SQLite + sqlite-vec, with models served by a local Ollama instance.

Tags: `offline` `RAG` `OCR` `local-files` `SQLite` `Tauri`

## Features

PL:
- Offline RAG: lokalny SQLite + sqlite-vec, zero płatnych API.
- Obsługa PDF/TXT/MD/DOCX + OCR dla skanów PDF.
- Lista źródeł (pliki/foldery z podfolderami), statusy indeksu i ręczne odświeżanie per plik.
- Auto-reindeksowanie po zmianie plików (watcher).
- Ustawienia zaawansowane: chunk size/overlap, MMR, threshold, OCR.

EN:
- Offline RAG: local SQLite + sqlite-vec, no paid APIs.
- Supports PDF/TXT/MD/DOCX + OCR for scanned PDFs.
- Sources list (files/folders with subfolders), index status, and manual refresh per file.
- Auto re-indexing on file changes (watcher).
- Advanced settings: chunk size/overlap, MMR, threshold, OCR.

## Tech stack

- Tauri + React
- SQLite + sqlite-vec
- Ollama (local models)
- Tesseract OCR

## First run / Setup

PL:
- Aplikacja sprawdza, czy Ollama działa lokalnie.
- Gdy Ollama nie działa, zobaczysz ekran "Setup / Dependencies" z przyciskami "Install Ollama" i "Retry".
- Po uruchomieniu Ollama aplikacja automatycznie pobierze modele domyślne:
  - Chat: `llama3.1:8b`
  - Fast RAG: `llama3.2:3b`
  - Embeddings: `qwen3-embedding`
- Pobranie modeli wymaga internetu tylko raz.

EN:
- The app checks if Ollama is running locally.
- If not, you will see the "Setup / Dependencies" screen with "Install Ollama" and "Retry".
- When Ollama is running, the app ensures default models are installed:
  - Chat: `llama3.1:8b`
  - Fast RAG: `llama3.2:3b`
  - Embeddings: `qwen3-embedding`
- Model downloads require internet only once.

## Requirements

- Ollama installed and running: https://ollama.com
- Bundled resources:
  - sqlite-vec extension: `src-tauri/resources/vec0.dll` (Windows) or `src-tauri/resources/libvec0.dylib` (macOS)
  - Tesseract CLI + tessdata: `src-tauri/resources/tesseract/**`

## OCR bundling (one-click installer)

- Run `npm run prepare-ocr` to download Tesseract + tessdata into `src-tauri/resources/tesseract`.
- `npx tauri build` runs this automatically (via `beforeBuildCommand`).
- Windows uses the UB Mannheim Tesseract installer by default (override with `TESSERACT_WIN_URL`).
- macOS uses Homebrew if available (or set `TESSERACT_DARWIN_DIR` to a custom install).
- Optional env vars:
  - `TESSERACT_DIR` (use existing install)
  - `TESSERACT_WIN_URL` (override Windows installer URL)
  - `TESSERACT_DARWIN_DIR` (macOS prefix to copy from)
  - `NO_BREW=1` (disable Homebrew lookup on macOS)
  - `TESS_LANGS` (default: `eng,pol,osd`)
  - `TESSDATA_BASE_URL` (default: `tessdata_fast` on GitHub)
  - `SKIP_TESSERACT=1` (skip OCR setup)

## Development

```bash
npm install
npx tauri dev
```

## Build installers

```bash
npx tauri build
```

Installers are created here:
- Windows (NSIS): `src-tauri/target/release/bundle/nsis/*.exe`
- macOS (DMG): `src-tauri/target/release/bundle/dmg/*.dmg`

macOS note: if the app is unsigned, Gatekeeper may block it on first run. Allow it in System Settings > Privacy & Security.

## Release (GitHub CLI)

Prerequisite:
```bash
gh auth login
```

Windows (PowerShell):
```powershell
scripts/release.ps1 0.5.0
```

macOS (bash):
```bash
scripts/release.sh 0.5.0
```

The scripts:
- update versions in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`
- commit `Release vX.Y.Z`, create tag `vX.Y.Z`, push
- build installers with `npx tauri build`
- create/update the GitHub release and upload installers

## License

MIT. See `LICENSE`.
