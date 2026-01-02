import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, beforeEach, expect, vi } from "vitest";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));

const setupStatusOk = {
  running: true,
  managed: false,
  models: ["llama3.1:8b", "llama3.2:3b", "qwen3-embedding"],
  defaultChat: "llama3.1:8b",
  defaultFast: "llama3.2:3b",
  defaultEmbed: "qwen3-embedding",
};
const UI_WAIT_MS = 4000;

describe("App integration", () => {
  const invokeMock = vi.mocked(invoke);
  const listenMock = vi.mocked(listen);

  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    listenMock.mockReset().mockResolvedValue(() => {});
  });

  it("shows setup modal when Ollama is not running", async () => {
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "setup_status") {
        return Promise.resolve({
          running: false,
          managed: false,
          models: [],
          defaultChat: "llama3.1:8b",
          defaultFast: "llama3.2:3b",
          defaultEmbed: "qwen3-embedding",
        });
      }
      if (cmd === "list_targets") return Promise.resolve([]);
      if (cmd === "list_cloud_models") return Promise.resolve([]);
      if (cmd === "set_ollama_host") return Promise.resolve();
      return Promise.resolve(null);
    });

    render(<App />);

    expect(await screen.findByText("Setup / Dependencies", {}, { timeout: UI_WAIT_MS })).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("sends a chat message and renders the response", async () => {
    localStorage.setItem("setup.complete", "true");
    const user = userEvent.setup();

    invokeMock.mockImplementation((cmd) => {
      if (cmd === "setup_status") return Promise.resolve(setupStatusOk);
      if (cmd === "list_models") return Promise.resolve(setupStatusOk.models);
      if (cmd === "list_cloud_models") return Promise.resolve([]);
      if (cmd === "list_targets") return Promise.resolve([]);
      if (cmd === "preview_index") return Promise.resolve([]);
      if (cmd === "save_targets") return Promise.resolve();
      if (cmd === "set_ollama_host") return Promise.resolve();
      if (cmd === "chat_stream") {
        return Promise.resolve({ answer: "Hello from Ollama", sources: [] });
      }
      return Promise.resolve(null);
    });

    render(<App />);

    const textarea = await screen.findByPlaceholderText("Ask about your documents...");
    const sendButton = screen.getByRole("button", { name: "Send" });

    await waitFor(() => expect(sendButton).toBeEnabled(), { timeout: UI_WAIT_MS });

    await user.type(textarea, "What is in the docs?");
    await user.click(sendButton);

    const expectedChatModel = setupStatusOk.defaultFast || setupStatusOk.defaultChat;
    await waitFor(
      () =>
        expect(invokeMock).toHaveBeenCalledWith(
          "chat_stream",
          expect.objectContaining({
            question: "What is in the docs?",
            llmModel: expectedChatModel,
            embedModel: "qwen3-embedding",
            settings: expect.objectContaining({ topK: 8 }),
          }),
        ),
      { timeout: UI_WAIT_MS },
    );

    expect(await screen.findByText("Hello from Ollama", {}, { timeout: UI_WAIT_MS })).toBeInTheDocument();
  });

  it("records chat history titles for new sessions", async () => {
    localStorage.setItem("setup.complete", "true");
    const user = userEvent.setup();

    invokeMock.mockImplementation((cmd) => {
      if (cmd === "setup_status") return Promise.resolve(setupStatusOk);
      if (cmd === "list_models") return Promise.resolve(setupStatusOk.models);
      if (cmd === "list_cloud_models") return Promise.resolve([]);
      if (cmd === "list_targets") return Promise.resolve([]);
      if (cmd === "preview_index") return Promise.resolve([]);
      if (cmd === "save_targets") return Promise.resolve();
      if (cmd === "set_ollama_host") return Promise.resolve();
      if (cmd === "chat_stream") {
        return Promise.resolve({ answer: "Hello from Ollama", sources: [] });
      }
      return Promise.resolve(null);
    });

    render(<App />);

    const textarea = await screen.findByPlaceholderText("Ask about your documents...");
    const sendButton = screen.getByRole("button", { name: "Send" });

    await waitFor(() => expect(sendButton).toBeEnabled(), { timeout: UI_WAIT_MS });

    await user.type(textarea, "What is in the docs?");
    await user.click(sendButton);

    expect(await screen.findByText("Hello from Ollama", {}, { timeout: UI_WAIT_MS })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "History" }));

    expect(await screen.findByText("What is in the docs?", {}, { timeout: UI_WAIT_MS })).toBeInTheDocument();
  });
});
