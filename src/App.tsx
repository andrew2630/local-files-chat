import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

type SourceHit = { path: string; page: number; snippet: string; score: number };
type ChatResponse = { answer: string; sources: SourceHit[] };

export default function App() {
  const [roots, setRoots] = useState<string[]>([]);
  const [chatModel, setChatModel] = useState("llama3.1:8b");
  const [embedModel, setEmbedModel] = useState("qwen3-embedding");
  const [q, setQ] = useState("");
  const [log, setLog] = useState<{ role: "user" | "assistant"; text: string; sources?: SourceHit[] }[]>([]);
  const [busy, setBusy] = useState(false);

  async function pickFolder() {
    const res = await open({ directory: true, multiple: false });
    if (typeof res === "string") setRoots((r) => [...new Set([...r, res])]);
  }

  async function doIndex() {
    setBusy(true);
    try {
      await invoke("start_index", { roots, embedModel });
      alert("Index done (MVP).");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const query = q.trim();
    if (!query) return;
    setQ("");
    setLog((l) => [...l, { role: "user", text: query }]);
    setBusy(true);
    try {
      const resp = (await invoke("chat", { query, roots, chatModel, embedModel })) as ChatResponse;
      setLog((l) => [...l, { role: "assistant", text: resp.answer, sources: resp.sources }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", height: "100vh" }}>
      <div style={{ borderRight: "1px solid #ddd", padding: 12 }}>
        <h3>Local Files Chat</h3>

        <button onClick={pickFolder} disabled={busy}>+ Add folder</button>
        <button onClick={doIndex} disabled={busy || roots.length === 0} style={{ marginLeft: 8 }}>
          Index now
        </button>

        <div style={{ marginTop: 12 }}>
          <div><b>Chat model</b></div>
          <input value={chatModel} onChange={(e) => setChatModel(e.target.value)} style={{ width: "100%" }} />
        </div>

        <div style={{ marginTop: 12 }}>
          <div><b>Embedding model</b></div>
          <input value={embedModel} onChange={(e) => setEmbedModel(e.target.value)} style={{ width: "100%" }} />
        </div>

        <div style={{ marginTop: 12 }}>
          <b>Folders</b>
          <ul>
            {roots.map((r) => <li key={r} style={{ wordBreak: "break-all" }}>{r}</li>)}
          </ul>
        </div>
      </div>

      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ flex: 1, overflow: "auto", border: "1px solid #ddd", padding: 12 }}>
          {log.map((m, i) => (
            <div key={i} style={{ marginBottom: 16 }}>
              <div><b>{m.role}</b></div>
              <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>

              {m.sources && m.sources.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <b>Sources</b>
                  {m.sources.map((s, idx) => (
                    <div key={idx} style={{ border: "1px solid #eee", padding: 8, marginTop: 6 }}>
                      <div style={{ fontSize: 12 }}>
                        <b>[{idx+1}]</b> {s.path} — page {s.page} — score {s.score.toFixed(4)}
                      </div>
                      <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{s.snippet}</div>
                      <div style={{ marginTop: 6 }}>
                        <button onClick={() => openPath(s.path)}>Open PDF</button>
                        <button onClick={() => revealItemInDir(s.path)} style={{ marginLeft: 8 }}>Reveal</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Ask your documents…"
            style={{ flex: 1 }}
            disabled={busy}
          />
          <button onClick={send} disabled={busy || roots.length === 0}>Send</button>
        </div>
      </div>
    </div>
  );
}
