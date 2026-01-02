import { describe, expect, it } from "vitest";
import {
  deriveTitle,
  formatSize,
  getMissingModels,
  isEmbeddingModel,
  loadJson,
  modelInstalled,
  splitModelTag,
} from "./App.helpers";

describe("App helpers", () => {
  it("detects embedding models", () => {
    expect(isEmbeddingModel("nomic-embed-text")).toBe(true);
    expect(isEmbeddingModel("BGE-small-en")).toBe(true);
    expect(isEmbeddingModel("llama3.1:8b")).toBe(false);
  });

  it("formats sizes with units", () => {
    expect(formatSize(0)).toBe("");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(10 * 1024 * 1024)).toBe("10 MB");
  });

  it("splits model tags", () => {
    expect(splitModelTag("llama3:8b")).toEqual({ base: "llama3", tag: "8b" });
    expect(splitModelTag("llama3")).toEqual({ base: "llama3", tag: null });
  });

  it("detects installed models with or without tags", () => {
    expect(modelInstalled(["llama3"], "llama3:8b")).toBe(true);
    expect(modelInstalled(["llama3:7b"], "llama3:8b")).toBe(false);
    expect(modelInstalled(["llama3:8b"], "llama3")).toBe(true);
    expect(modelInstalled(["other"], "llama3")).toBe(false);
  });

  it("reports missing default models", () => {
    const missing = getMissingModels(["chat:latest", "embed"], {
      chat: "chat",
      fast: "fast",
      embed: "embed",
    });
    expect(missing).toEqual(["fast"]);
  });

  it("derives titles from the first user message", () => {
    expect(
      deriveTitle(
        [
          { role: "assistant", text: "ignored" },
          { role: "user", text: "Hello world" },
        ],
        "Fallback",
      ),
    ).toBe("Hello world");
    const longText = "a".repeat(80);
    expect(deriveTitle([{ role: "user", text: longText }], "Fallback")).toBe(longText.slice(0, 48));
    expect(deriveTitle([{ role: "assistant", text: "only bot" }], "Fallback")).toBe("Fallback");
  });

  it("loads JSON with fallback on errors", () => {
    localStorage.setItem("test.json", "{");
    expect(loadJson("test.json", { ok: true })).toEqual({ ok: true });
    localStorage.setItem("test.json", "{\"value\":42}");
    expect(loadJson("test.json", { ok: false })).toEqual({ value: 42 });
    localStorage.removeItem("test.json");
    expect(loadJson("test.json", 7)).toBe(7);
  });
});
