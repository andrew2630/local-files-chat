#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCES_DIR = path.join(ROOT, "src-tauri", "resources", "tesseract");
const TESSDATA_DIR = path.join(RESOURCES_DIR, "tessdata");
const CACHE_DIR = path.join(RESOURCES_DIR, "_installer");
const DOWNLOAD_RETRIES = 2;
const DOWNLOAD_RETRY_DELAY_MS = 1500;

const SKIP =
  process.env.SKIP_OCR_SETUP === "1" ||
  process.env.SKIP_TESSERACT === "1" ||
  process.env.LOCAL_FILES_CHAT_SKIP_OCR === "1";

if (SKIP) {
  console.log("OCR setup skipped.");
  process.exit(0);
}

fs.mkdirSync(RESOURCES_DIR, { recursive: true });

const existingBin = findTesseractBin(RESOURCES_DIR);
if (!existingBin) {
  const providedDir = process.env.TESSERACT_DIR;
  if (providedDir) {
    copyDirectory(providedDir, RESOURCES_DIR);
  } else {
    const pathBin = findTesseractOnPath();
    if (pathBin) {
      copyFromPathTesseract(pathBin, RESOURCES_DIR);
    } else if (process.platform === "win32") {
      await installWindowsTesseract(RESOURCES_DIR);
    } else if (process.platform === "darwin") {
      await installDarwinTesseract(RESOURCES_DIR);
    } else {
      console.error("Tesseract not found. Set TESSERACT_DIR to continue.");
      process.exit(1);
    }
  }
}

await ensureTessdata(TESSDATA_DIR);
console.log("OCR assets ready.");

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findTesseractBin(baseDir) {
  const candidates = [
    path.join(baseDir, "bin", "tesseract.exe"),
    path.join(baseDir, "tesseract.exe"),
    path.join(baseDir, "bin", "tesseract"),
    path.join(baseDir, "tesseract"),
  ];
  return candidates.find(fileExists) ?? null;
}

function findTesseractOnPath() {
  const pathValue = process.env.PATH ?? "";
  const entries = pathValue.split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["tesseract.exe", "tesseract"] : ["tesseract"];
  for (const entry of entries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

function copyFromPathTesseract(binPath, targetDir) {
  const binDir = path.dirname(binPath);
  const isBinDir = path.basename(binDir).toLowerCase() === "bin";
  const root = isBinDir ? path.dirname(binDir) : binDir;

  if (process.platform === "win32") {
    copyDirectory(root, targetDir);
    return;
  }

  if (process.platform === "darwin") {
    const binSrc = path.join(root, "bin");
    const libSrc = path.join(root, "lib");
    const shareSrc = path.join(root, "share", "tessdata");

    if (fs.existsSync(binSrc)) copyDirectory(binSrc, path.join(targetDir, "bin"));
    if (fs.existsSync(libSrc)) copyDirectory(libSrc, path.join(targetDir, "lib"));
    if (fs.existsSync(shareSrc)) copyDirectory(shareSrc, path.join(targetDir, "share", "tessdata"));
    if (!fs.existsSync(binSrc)) copyDirectory(binDir, targetDir);
    return;
  }
}

function copyDirectory(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function isFileUrl(value) {
  return /^file:\/\//i.test(value);
}

function resolveLocalInstaller(override) {
  if (!override) return null;
  const trimmed = override.trim();
  if (!trimmed) return null;
  if (isFileUrl(trimmed)) {
    try {
      const filePath = fileURLToPath(trimmed);
      return fileExists(filePath) ? filePath : null;
    } catch {
      return null;
    }
  }
  if (!isHttpUrl(trimmed)) {
    const candidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(ROOT, trimmed);
    return fileExists(candidate) ? candidate : null;
  }
  return null;
}

async function installWindowsTesseract(targetDir) {
  const override = process.env.TESSERACT_WIN_URL;
  const localInstaller = resolveLocalInstaller(override);
  if (override && !isHttpUrl(override) && !localInstaller) {
    throw new Error(`TESSERACT_WIN_URL points to a missing file: ${override}`);
  }

  let installer = localInstaller;
  let cleanup = false;

  if (!installer) {
    const urls = override
      ? [override]
      : [
          "https://github.com/UB-Mannheim/tesseract/releases/latest/download/tesseract-ocr-w64-setup.exe",
        ];
    if (!override) {
      const apiUrl = await resolveWindowsInstallerFromApi();
      if (apiUrl && !urls.includes(apiUrl)) urls.push(apiUrl);
    }
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    installer = path.join(CACHE_DIR, `tesseract-setup-${Date.now()}.exe`);
    cleanup = true;
    console.log(`Downloading Tesseract: ${urls[0]}`);
    await downloadWithFallback(urls, installer);
  } else {
    console.log(`Using local Tesseract installer: ${installer}`);
  }

  console.log("Installing Tesseract...");
  await runInstaller(installer, targetDir);
  if (cleanup) fs.rmSync(installer, { force: true });
}

async function installDarwinTesseract(targetDir) {
  const override = process.env.TESSERACT_DARWIN_DIR;
  const prefix = override ?? (await brewPrefix("tesseract"));
  if (!prefix) {
    console.error("Tesseract not found on macOS. Install with Homebrew or set TESSERACT_DARWIN_DIR.");
    process.exit(1);
  }

  const binSrc = path.join(prefix, "bin");
  const libSrc = path.join(prefix, "lib");
  const shareSrc = path.join(prefix, "share", "tessdata");

  if (fs.existsSync(binSrc)) copyDirectory(binSrc, path.join(targetDir, "bin"));
  if (fs.existsSync(libSrc)) copyDirectory(libSrc, path.join(targetDir, "lib"));
  if (fs.existsSync(shareSrc)) copyDirectory(shareSrc, path.join(targetDir, "share", "tessdata"));
}

async function ensureTessdata(tessdataDir) {
  const langs = (process.env.TESS_LANGS ?? "eng,pol,osd")
    .split(/[,+]/)
    .map((lang) => lang.trim())
    .filter(Boolean);
  if (langs.length === 0) return;
  fs.mkdirSync(tessdataDir, { recursive: true });

  const base =
    process.env.TESSDATA_BASE_URL ??
    "https://github.com/tesseract-ocr/tessdata_fast/raw/main";

  for (const lang of langs) {
    const target = path.join(tessdataDir, `${lang}.traineddata`);
    if (fileExists(target)) continue;
    const url = `${base}/${lang}.traineddata`;
    console.log(`Downloading tessdata: ${lang}`);
    await downloadToFileWithRetry(url, target);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadToFile(url, dest, redirects = 0) {
  if (redirects > 5) {
    throw new Error(`Too many redirects for ${url}`);
  }
  await new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "local-files-chat" } },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          downloadToFile(next, dest, redirects + 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(Object.assign(new Error(`Download failed ${res.statusCode} for ${url}`), { status: res.statusCode }));
          return;
        }
        pipeline(res, fs.createWriteStream(dest)).then(resolve).catch(reject);
      },
    );
    req.on("error", reject);
  });
}

async function downloadToFileWithRetry(url, dest) {
  let attempts = 0;
  while (true) {
    try {
      await downloadToFile(url, dest);
      return;
    } catch (err) {
      attempts += 1;
      fs.rmSync(dest, { force: true });
      if (attempts > DOWNLOAD_RETRIES) throw err;
      await delay(DOWNLOAD_RETRY_DELAY_MS * attempts);
    }
  }
}

async function downloadWithFallback(urls, dest) {
  const errors = [];
  for (const url of urls) {
    try {
      await downloadToFileWithRetry(url, dest);
      return;
    } catch (err) {
      errors.push(err);
    }
  }
  const messages = errors.map((e) => (e && e.message ? e.message : String(e))).join("; ");
  throw new Error(`All downloads failed: ${messages}`);
}

async function resolveWindowsInstallerFromApi() {
  const api = "https://api.github.com/repos/UB-Mannheim/tesseract/releases/latest";
  try {
    const data = await fetchJson(api);
    const assets = Array.isArray(data?.assets) ? data.assets : [];
    const match = assets.find((asset) => {
      const name = typeof asset?.name === "string" ? asset.name : "";
      return name.includes("tesseract-ocr-w64-setup") && name.endsWith(".exe") && !name.includes("portable");
    });
    const url = match?.browser_download_url;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

async function fetchJson(url, redirects = 0) {
  if (redirects > 5) {
    throw new Error(`Too many redirects for ${url}`);
  }
  return await new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "local-files-chat" } },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          fetchJson(next, redirects + 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Fetch failed ${res.statusCode} for ${url}`));
          return;
        }
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
  });
}

async function runInstaller(installer, targetDir) {
  try {
    await runInstallerSpawn(installer, targetDir);
  } catch (err) {
    if (err && err.code === "EACCES") {
      await runInstallerViaShell(installer, targetDir);
      return;
    }
    throw err;
  }
}

async function runInstallerSpawn(installer, targetDir) {
  await new Promise((resolve, reject) => {
    const args = ["/S", `/D=${targetDir}`];
    const child = spawn(installer, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Installer exited with code ${code}`));
    });
  });
}

async function runInstallerViaShell(installer, targetDir) {
  const safeInstaller = installer.replace(/'/g, "''");
  const safeTarget = targetDir.replace(/'/g, "''");
  const command =
    `Start-Process -FilePath '${safeInstaller}' -ArgumentList @('/S','/D=${safeTarget}') -Wait`;
  await runCommand("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ]);
}

async function brewPrefix(pkgName) {
  if (process.env.NO_BREW === "1") return null;
  try {
    const result = await runCommand("brew", ["--prefix", pkgName], { capture: true });
    const prefix = result.trim();
    return prefix ? prefix : null;
  } catch {
    return null;
  }
}

async function runCommand(command, args, options = {}) {
  const capture = options.capture === true;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let out = "";
    if (capture) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        out += chunk;
      });
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
