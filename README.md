# Local Files Chat

PL: Lokalna aplikacja desktopowa (Tauri + React) do rozmowy z dokumentami offline. Indeksowanie i wyszukiwanie działa lokalnie w SQLite + sqlite-vec, a modele są uruchamiane przez lokalną instancję Ollama.
EN: Local desktop app (Tauri + React) for offline document chat. Indexing and retrieval run locally in SQLite + sqlite-vec, with models served by a local Ollama instance.

## Features

- Offline RAG: lokalny SQLite + sqlite-vec, zero płatnych API.
- Obsługa PDF/TXT/MD/DOCX + OCR dla skanów PDF.
- Lista źródeł (pliki/foldery z podfolderami), statusy indeksu i ręczne odświeżanie per plik.
- Auto-reindeksowanie po zmianie plików (watcher).
- Ustawienia zaawansowane: chunk size/overlap, MMR, threshold, OCR.

## First run / Setup

PL:
- Aplikacja sprawdza, czy Ollama działa lokalnie.
- Gdy Ollama nie działa, zobaczysz ekran „Setup / Dependencies” z przyciskami „Install Ollama” i „Retry”.
- Po uruchomieniu Ollama aplikacja automatycznie pobierze modele domyślne:
  - Chat: `llama3.1:8b`
  - Embeddings: `qwen3-embedding`
- Pobranie modeli wymaga internetu tylko raz.

EN:
- The app checks if Ollama is running locally.
- If not, you will see the “Setup / Dependencies” screen with “Install Ollama” and “Retry”.
- When Ollama is running, the app ensures default models are installed:
  - Chat: `llama3.1:8b`
  - Embeddings: `qwen3-embedding`
- Model downloads require internet only once.

## Requirements

- Ollama installed and running: https://ollama.com
- Bundled resources:
  - sqlite-vec extension: `src-tauri/resources/vec0.dll` (Windows) or `src-tauri/resources/libvec0.dylib` (macOS)
  - Tesseract CLI + tessdata: `src-tauri/resources/tesseract/**`

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
scripts/release.ps1 0.1.0
```

macOS (bash):
```bash
scripts/release.sh 0.1.0
```

The scripts:
- update versions in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`
- commit `Release vX.Y.Z`, create tag `vX.Y.Z`, push
- build installers with `npx tauri build`
- create/update the GitHub release and upload installers

