import { useEffect, useState } from "react";
import * as client from "./client.js";
import type { McpServer } from "./client.js";

type TestState = "idle" | "testing" | "ok" | "error";

function IconTrash() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function AddConnectorModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [mode, setMode] = useState<"url" | "json">("url");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [json, setJson] = useState("");
  const [state, setState] = useState<TestState>("idle");
  const [message, setMessage] = useState("");

  async function addAndTestUrl() {
    if (!name.trim() || !url.trim()) return;
    setState("testing");
    setMessage("");
    const headers = parseHeaderLines(headersText);
    const result = await client.testMcpServer({ transport: "http", url: url.trim(), headers });
    if (result.ok) {
      await client.putMcpServer(name.trim(), { transport: "http", url: url.trim(), headers, enabled: true });
      setState("ok");
      setMessage(`Connected — found ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}${result.tools?.length ? `: ${result.tools.slice(0, 6).join(", ")}${result.tools.length > 6 ? "…" : ""}` : ""}.`);
      setTimeout(onSaved, 1000);
    } else {
      setState("error");
      setMessage(result.error ?? "Connection failed.");
    }
  }

  async function saveWithoutTesting() {
    if (!name.trim() || !url.trim()) return;
    await client.putMcpServer(name.trim(), { transport: "http", url: url.trim(), headers: parseHeaderLines(headersText), enabled: false });
    onSaved();
  }

  async function addAndTestJson() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      setState("error");
      setMessage("That isn't valid JSON.");
      return;
    }
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      setState("error");
      setMessage('Expected the shape {"mcpServers": {"name": {...}}} — the same block most MCP server docs publish.');
      return;
    }
    setState("testing");
    setMessage("");
    const entries = Object.entries(servers as Record<string, Record<string, unknown>>);
    const lines: string[] = [];
    for (const [entryName, cfg] of entries) {
      const candidate: client.McpTestCandidate = {
        transport: typeof cfg.url === "string" ? "http" : "stdio",
        command: typeof cfg.command === "string" ? cfg.command : undefined,
        args: Array.isArray(cfg.args) ? (cfg.args as string[]) : [],
        env: (cfg.env as Record<string, string> | undefined) ?? {},
        url: typeof cfg.url === "string" ? cfg.url : undefined,
        headers: (cfg.headers as Record<string, string> | undefined) ?? {},
      };
      const result = await client.testMcpServer(candidate);
      await client.putMcpServer(entryName, { ...candidate, enabled: true });
      lines.push(result.ok ? `${entryName} — connected (${result.toolCount} tools)` : `${entryName} — failed: ${result.error}`);
    }
    setState(lines.every((l) => l.includes("connected")) ? "ok" : "error");
    setMessage(lines.join("\n"));
    setTimeout(onSaved, 1400);
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <h3>Add custom connector</h3>
        <div className="connector-modal-tabs">
          <button className={`connector-modal-tab${mode === "url" ? " active" : ""}`} onClick={() => setMode("url")}>
            Remote URL
          </button>
          <button className={`connector-modal-tab${mode === "json" ? " active" : ""}`} onClick={() => setMode("json")}>
            JSON
          </button>
        </div>
        {mode === "url" ? (
          <>
            <p className="reason">Connect a hosted MCP server over HTTP. "Add & test" connects for real before saving anything.</p>
            <div className="new-item-form" style={{ border: "none", padding: 0 }}>
              <input placeholder="Name (shown in the connectors list)" value={name} onChange={(e) => setName(e.target.value)} />
              <input placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} style={{ fontFamily: "var(--font-mono)" }} />
              <textarea rows={2} placeholder="Optional headers, one per line — Authorization: Bearer sk-..." value={headersText} onChange={(e) => setHeadersText(e.target.value)} />
            </div>
          </>
        ) : (
          <>
            <p className="reason">Paste an MCP config block — the same {"{"}"mcpServers": {"{"}...{"}"}{"}"} JSON most server docs publish. Every entry is tested before it's saved.</p>
            <textarea
              rows={8}
              placeholder={'{\n  "mcpServers": {\n    "my-server": {\n      "command": "npx",\n      "args": ["-y", "some-mcp-server"]\n    }\n  }\n}'}
              value={json}
              onChange={(e) => setJson(e.target.value)}
              style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 12.5, padding: 10, borderRadius: 8, border: "1px solid var(--line-strong)" }}
            />
          </>
        )}
        {state !== "idle" && (
          <div className={state === "error" ? "error-banner" : state === "ok" ? "connector-test-ok" : "connector-test-pending"} style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>
            {state === "testing" ? "Testing connection…" : message}
          </div>
        )}
        <div className="dialog-actions" style={{ marginTop: 16 }}>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          {mode === "url" && state === "error" && (
            <button className="btn-secondary" onClick={saveWithoutTesting}>
              Save anyway
            </button>
          )}
          <button
            className="btn-primary accent"
            disabled={state === "testing" || (mode === "url" ? !name.trim() || !url.trim() : !json.trim())}
            onClick={mode === "url" ? addAndTestUrl : addAndTestJson}
          >
            {state === "testing" ? "Testing…" : "Add & test"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Connectors({ workspace }: { workspace: string }) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [trusted, setTrusted] = useState<boolean | null>(null);

  function refresh() {
    client.listMcpServers().then((r) => setServers(r.servers));
    if (workspace) client.getWorkspaceTrust(workspace).then((r) => setTrusted(r.trusted));
  }
  useEffect(refresh, [workspace]);

  async function toggleTrust() {
    if (!workspace || trusted === null) return;
    await client.setWorkspaceTrust(workspace, !trusted);
    setTrusted(!trusted);
  }

  return (
    <div className="settings-body" style={{ maxWidth: 760, margin: "0 auto", width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 8 }}>
        <div>
          <h2 style={{ marginBottom: 4 }}>Connectors</h2>
          <p className="desc" style={{ margin: 0 }}>
            Tool servers your sessions can use, over the Model Context Protocol.
          </p>
        </div>
        <button className="btn-primary accent" style={{ height: 40, whiteSpace: "nowrap" }} onClick={() => setShowModal(true)}>
          + Add custom connector
        </button>
      </div>

      {workspace && trusted !== null && (
        <div className="default-model-banner" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 20 }}>
          <span>
            This workspace's own <code className="inline-code">.metaharn/mcp.json</code> is <strong>{trusted ? "trusted" : "not trusted"}</strong> —{" "}
            {trusted ? "its connectors load automatically." : "it's ignored until you trust this workspace."}
          </span>
          <button
            className="btn-sm"
            style={{ background: trusted ? "transparent" : "var(--ink)", color: trusted ? "var(--bad)" : "#fff", border: trusted ? "1px solid var(--bad-soft)" : "none" }}
            onClick={toggleTrust}
          >
            {trusted ? "Revoke trust" : "Trust this workspace"}
          </button>
        </div>
      )}

      {servers.length === 0 && (
        <div className="empty-state">
          <h3>No connectors yet</h3>
          <p>Add an MCP server — a hosted URL, or paste a JSON config block.</p>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        {servers.map((s) => (
          <div className="list-card" key={s.name}>
            <div className="list-card-main">
              <div className="list-card-title">{s.name}</div>
              <div className="list-card-sub">{s.transport === "http" ? s.url : `${s.command} ${s.args.join(" ")}`}</div>
            </div>
            <div className="list-card-actions">
              <button
                className={`switch${s.enabled ? " on" : ""}`}
                aria-label={s.enabled ? "Disable connector" : "Enable connector"}
                title={s.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
                onClick={() => client.putMcpServer(s.name, { enabled: !s.enabled }).then(refresh)}
              />
              <button
                className="list-card-icon-btn danger"
                aria-label="Remove connector"
                title="Remove"
                onClick={() => client.deleteMcpServer(s.name).then(refresh)}
              >
                <IconTrash />
              </button>
            </div>
          </div>
        ))}
      </div>

      {showModal && (
        <AddConnectorModal
          onClose={() => setShowModal(false)}
          onSaved={() => {
            setShowModal(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}
