const EMBED_HINTS = ["embed", "embedding", "bge", "e5", "nomic-embed", "gte", "instructor"];

type DeriveTitleMessage = { role: "user" | "assistant"; text: string };

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

export function deriveTitle(messages: DeriveTitleMessage[], fallback: string) {
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
