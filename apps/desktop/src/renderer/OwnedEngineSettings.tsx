import { useEffect, useState } from "react";
import type {
  OwnedAutomation,
  OwnedAutomationSchedule,
  OwnedGeneralSettings,
  OwnedMcpServer,
  OwnedMcpTestCandidate,
  OwnedMemoryItem,
  OwnedMemoryScope,
  OwnedProviderStatus,
} from "../preload/preload.js";
import { Row, Section, SegmentedControl, SPACE, TEXT } from "./ui.js";
import { PlayIcon, TrashIcon } from "./icons.js";
// Real vendor marks, not two-letter initials — see apps/web/src/Settings.tsx's identical import
// block for why @lobehub/icons-static-svg specifically (MIT, built for AI-provider logos;
// simple-icons was checked and rejected — no entry for OpenAI/Groq/xAI/Fireworks/Together) and
// why SVG rather than a downloaded PNG per company site (a vector has no resolution to be wrong
// at). Mirrored here rather than shared from apps/web since the two renderers don't share code.
import claudeColorSvg from "@lobehub/icons-static-svg/icons/claude-color.svg?raw";
import openaiSvg from "@lobehub/icons-static-svg/icons/openai.svg?raw";
import ollamaSvg from "@lobehub/icons-static-svg/icons/ollama.svg?raw";
import openrouterColorSvg from "@lobehub/icons-static-svg/icons/openrouter-color.svg?raw";
import togetherColorSvg from "@lobehub/icons-static-svg/icons/together-color.svg?raw";
import fireworksColorSvg from "@lobehub/icons-static-svg/icons/fireworks-color.svg?raw";
import deepseekColorSvg from "@lobehub/icons-static-svg/icons/deepseek-color.svg?raw";
import groqSvg from "@lobehub/icons-static-svg/icons/groq.svg?raw";
import mistralColorSvg from "@lobehub/icons-static-svg/icons/mistral-color.svg?raw";
import grokSvg from "@lobehub/icons-static-svg/icons/grok.svg?raw";

const PROVIDER_ICON_SVG: Record<string, string> = {
  anthropic: claudeColorSvg,
  openai: openaiSvg,
  ollama: ollamaSvg,
  openrouter: openrouterColorSvg,
  together: togetherColorSvg,
  fireworks: fireworksColorSvg,
  deepseek: deepseekColorSvg,
  groq: groqSvg,
  mistral: mistralColorSvg,
  xai: grokSvg,
};

/** Renders a vendor's real SVG mark — build-time trusted content (an installed npm package,
 * never user input), so innerHTML here carries no XSS risk. */
function ProviderIcon({ name }: { name: string }) {
  const svg = PROVIDER_ICON_SVG[name];
  if (!svg) return null;
  return (
    <span
      style={{ width: 18, height: 18, display: "grid", placeItems: "center", color: "var(--color-text)", flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

const MONO = '"IBM Plex Mono", Menlo, Monaco, monospace';

const MODEL_PLACEHOLDER: Record<string, string> = {
  anthropic: "claude-opus-4-5",
  openai: "gpt-5",
  ollama: "llama3.3",
  openrouter: "openai/gpt-4o",
  together: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  fireworks: "accounts/fireworks/models/llama-v3p3-70b-instruct",
  deepseek: "deepseek-chat",
  groq: "llama-3.3-70b-versatile",
  mistral: "mistral-large-latest",
  xai: "grok-4",
};

type Tab = "general" | "models" | "memory" | "mcp" | "automations";

const TABS: { value: Tab; label: string }[] = [
  { value: "general", label: "General" },
  { value: "models", label: "Models" },
  { value: "memory", label: "Memory" },
  { value: "mcp", label: "Connectors" },
  { value: "automations", label: "Automations" },
];

function TextInput({ value, onChange, placeholder, type = "text", width }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string; width?: number }) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: width ?? 200,
        padding: "6px 10px",
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        background: "var(--color-bg)",
        color: "var(--color-text)",
        fontSize: TEXT.base,
        fontFamily: type === "password" ? undefined : MONO,
      }}
    />
  );
}

function SmallButton({ onClick, disabled, danger, children }: { onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "5px 12px",
        borderRadius: 6,
        border: danger ? "1px solid var(--color-border)" : "none",
        background: danger ? "transparent" : "var(--color-accent)",
        color: danger ? "var(--color-text-secondary)" : "#fff",
        cursor: disabled ? "default" : "pointer",
        fontSize: TEXT.sm,
        opacity: disabled ? 0.6 : 1,
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

function ListRow({ title, sub, icon, children }: { title: string; sub?: string; icon?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div
      className="metaharn-list-row"
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: `${SPACE.md}px ${SPACE.lg}px`,
        borderBottom: "1px solid var(--color-border)",
        gap: SPACE.md,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, minWidth: 0 }}>
        {icon}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: TEXT.base }}>{title}</div>
          {sub && <div style={{ fontSize: TEXT.sm, color: "var(--color-text-secondary)", marginTop: 2, fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>}
        </div>
      </div>
      <div style={{ display: "flex", gap: SPACE.xs, flexShrink: 0 }}>{children}</div>
    </div>
  );
}

/** Icon-only row action, revealed on row hover via .metaharn-list-row:hover in theme.css —
 * matches apps/web/src/shell.css's identical .list-card-icon-btn, so a row of several actions
 * doesn't repeat the same button down a long list. */
function IconButton({ onClick, disabled, danger, label, children }: { onClick: () => void; disabled?: boolean; danger?: boolean; label: string; children: React.ReactNode }) {
  return (
    <button
      className={`metaharn-list-row-icon-btn${danger ? " danger" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{ opacity: disabled ? 0.35 : undefined, cursor: disabled ? "default" : undefined }}
    >
      {children}
    </button>
  );
}

/** Same visual switch GeneralPanel's Auto-Approve toggle already used inline — pulled out into
 * a reusable component now that AutomationsPanel needs an identical one for Pause/Resume. */
function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        width: 42,
        height: 24,
        borderRadius: 999,
        border: "none",
        background: on ? "var(--color-accent)" : "var(--color-border)",
        position: "relative",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: on ? 21 : 3,
          width: 18,
          height: 18,
          borderRadius: 999,
          background: "#fff",
          transition: "left 120ms ease",
        }}
      />
    </button>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: `${SPACE.md}px ${SPACE.lg}px`, fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>{children}</div>;
}

function FormBar({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: SPACE.lg, borderBottom: "1px solid var(--color-border)", display: "flex", gap: SPACE.sm, flexWrap: "wrap" }}>{children}</div>;
}

// -- General -------------------------------------------------------------------------------

function GeneralPanel() {
  const [settings, setSettings] = useState<OwnedGeneralSettings | null>(null);

  function refresh() {
    void window.metaharn.getOwnedSettings().then(setSettings);
  }
  useEffect(refresh, []);

  return (
    <>
      <Row
        label="Auto-Approve mode"
        description="An LLM reviewer judges routine tool approvals before they'd otherwise interrupt you. Off by default."
        control={
          <Toggle
            on={!!settings?.autoApprove}
            label="Toggle auto-approve mode"
            onClick={() => settings && void window.metaharn.setOwnedAutoApprove(!settings.autoApprove).then(refresh)}
          />
        }
      />
      <Row
        label="Default model"
        description="Used for new owned-engine sessions (METAHARN_CHAT_ENGINE=owned). Changed from the Models tab."
        control={<span style={{ fontSize: TEXT.base, fontFamily: MONO }}>{settings ? `${settings.defaultModel.provider}:${settings.defaultModel.modelId}` : "…"}</span>}
      />
    </>
  );
}

// -- Models ------------------------------------------------------------------------------

function ModelsPanel() {
  const [providers, setProviders] = useState<OwnedProviderStatus[] | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});

  function refresh() {
    void window.metaharn.listOwnedProviders().then(setProviders);
  }
  useEffect(refresh, []);

  return (
    <>
      {providers === null && <EmptyRow>Loading…</EmptyRow>}
      {providers?.map((p) => (
        <ListRow key={p.name} title={p.displayName} sub={p.configured ? (p.noKeyNeeded ? p.baseUrl : "Configured") : "Not set up"} icon={<ProviderIcon name={p.name} />}>
          {p.noKeyNeeded ? null : (
            <>
              <TextInput
                type="password"
                placeholder={p.configured ? "•••••• (replace)" : "API key"}
                value={keyDrafts[p.name] ?? ""}
                onChange={(v) => setKeyDrafts((d) => ({ ...d, [p.name]: v }))}
                width={150}
              />
              <SmallButton
                disabled={!keyDrafts[p.name]}
                onClick={() =>
                  void window.metaharn.setOwnedProvider(p.name, { apiKey: keyDrafts[p.name] }).then(() => {
                    setKeyDrafts((d) => ({ ...d, [p.name]: "" }));
                    refresh();
                  })
                }
              >
                Save
              </SmallButton>
              {p.configured && (
                <SmallButton danger onClick={() => void window.metaharn.deleteOwnedProviderKey(p.name).then(refresh)}>
                  Remove
                </SmallButton>
              )}
            </>
          )}
          {p.configured && (
            <>
              <TextInput placeholder={MODEL_PLACEHOLDER[p.name] ?? "model id"} value={modelDrafts[p.name] ?? ""} onChange={(v) => setModelDrafts((d) => ({ ...d, [p.name]: v }))} width={160} />
              <SmallButton danger disabled={!modelDrafts[p.name]} onClick={() => void window.metaharn.setOwnedDefaultModel(p.name, modelDrafts[p.name]).then(refresh)}>
                Set default
              </SmallButton>
            </>
          )}
        </ListRow>
      ))}
    </>
  );
}

// -- Memory ------------------------------------------------------------------------------

function MemoryPanel() {
  const [memories, setMemories] = useState<OwnedMemoryItem[] | null>(null);
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<OwnedMemoryScope>("global");

  function refresh() {
    void window.metaharn.listOwnedMemories().then(setMemories);
  }
  useEffect(refresh, []);

  return (
    <>
      <FormBar>
        <TextInput value={content} onChange={setContent} placeholder="Add a memory…" width={340} />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as OwnedMemoryScope)}
          style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text)", fontSize: TEXT.base }}
        >
          <option value="global">Global</option>
          <option value="workspace">Workspace</option>
        </select>
        <SmallButton
          disabled={!content.trim()}
          onClick={() =>
            void window.metaharn.addOwnedMemory(content.trim(), { scope }).then(() => {
              setContent("");
              refresh();
            })
          }
        >
          Add
        </SmallButton>
      </FormBar>
      {memories?.length === 0 && <EmptyRow>No memories yet.</EmptyRow>}
      {memories?.map((m) => (
        <ListRow key={m.id} title={m.content} sub={m.workspace ? `${m.scope} · ${m.workspace}` : m.scope}>
          <SmallButton danger onClick={() => void window.metaharn.deleteOwnedMemory(m.id).then(refresh)}>
            Delete
          </SmallButton>
        </ListRow>
      ))}
    </>
  );
}

// -- MCP ---------------------------------------------------------------------------------

function WorkspaceTrustRow() {
  const [workspace, setWorkspace] = useState("");
  const [trusted, setTrusted] = useState<boolean | null>(null);

  function check(path: string) {
    if (!path.trim()) {
      setTrusted(null);
      return;
    }
    void window.metaharn.isOwnedWorkspaceTrusted(path.trim()).then(setTrusted);
  }

  return (
    <div style={{ padding: SPACE.lg, borderBottom: "1px solid var(--color-border)" }}>
      <div style={{ fontSize: TEXT.sm, color: "var(--color-text-secondary)", marginBottom: SPACE.sm }}>
        A workspace's own <code style={{ fontFamily: MONO }}>.metaharn/mcp.json</code> only loads once you trust that path — check or grant trust here.
      </div>
      <div style={{ display: "flex", gap: SPACE.sm }}>
        <TextInput
          value={workspace}
          onChange={(v) => {
            setWorkspace(v);
            check(v);
          }}
          placeholder="Workspace path"
          width={300}
        />
        {trusted !== null && (
          <>
            <span style={{ fontSize: TEXT.base, alignSelf: "center", color: trusted ? "var(--color-accent)" : "var(--color-text-muted)" }}>{trusted ? "Trusted" : "Not trusted"}</span>
            <SmallButton
              danger={trusted}
              onClick={() =>
                void window.metaharn.setOwnedWorkspaceTrust(workspace.trim(), !trusted).then(() => {
                  setTrusted(!trusted);
                })
              }
            >
              {trusted ? "Revoke trust" : "Trust this workspace"}
            </SmallButton>
          </>
        )}
      </div>
    </div>
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
  const [mode, setMode] = useState<"url" | "json" | "stdio">("url");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [json, setJson] = useState("");
  const [state, setState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");

  async function addAndTest() {
    if (!name.trim()) return;
    if (mode === "url" && !url.trim()) return;
    if (mode === "stdio" && !command.trim()) return;
    setState("testing");
    setMessage("");
    const candidate: OwnedMcpTestCandidate =
      mode === "url"
        ? { transport: "http", url: url.trim(), headers: parseHeaderLines(headersText) }
        : { transport: "stdio", command: command.trim(), args: args ? args.split(" ").filter(Boolean) : [] };
    const result = await window.metaharn.testOwnedMcpServer(candidate);
    if (result.ok) {
      await window.metaharn.putOwnedMcpServer(name.trim(), { ...candidate, enabled: true });
      setState("ok");
      setMessage(`Connected — found ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}.`);
      setTimeout(onSaved, 1000);
    } else {
      setState("error");
      setMessage(result.error ?? "Connection failed.");
    }
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
      setMessage('Expected {"mcpServers": {"name": {...}}}.');
      return;
    }
    setState("testing");
    setMessage("");
    const lines: string[] = [];
    for (const [entryName, raw] of Object.entries(servers as Record<string, Record<string, unknown>>)) {
      const candidate = {
        transport: (typeof raw.url === "string" ? "http" : "stdio") as "stdio" | "http",
        command: typeof raw.command === "string" ? raw.command : undefined,
        args: Array.isArray(raw.args) ? (raw.args as string[]) : [],
        env: (raw.env as Record<string, string> | undefined) ?? {},
        url: typeof raw.url === "string" ? raw.url : undefined,
        headers: (raw.headers as Record<string, string> | undefined) ?? {},
      };
      const result = await window.metaharn.testOwnedMcpServer(candidate);
      await window.metaharn.putOwnedMcpServer(entryName, { ...candidate, enabled: true });
      lines.push(result.ok ? `${entryName} — connected (${result.toolCount} tools)` : `${entryName} — failed: ${result.error}`);
    }
    setState(lines.every((l) => l.includes("connected")) ? "ok" : "error");
    setMessage(lines.join("\n"));
    setTimeout(onSaved, 1400);
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--color-bg-elevated)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 20, width: 480, boxShadow: "0 8px 24px rgba(0,0,0,0.25)" }}>
        <div style={{ fontSize: TEXT.lg, fontWeight: 600, marginBottom: 10 }}>Add custom connector</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {(["url", "stdio", "json"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: "5px 12px",
                borderRadius: 999,
                border: "1px solid var(--color-border)",
                background: mode === m ? "var(--color-accent)" : "transparent",
                color: mode === m ? "#fff" : "var(--color-text)",
                cursor: "pointer",
                fontSize: TEXT.sm,
                fontWeight: 600,
              }}
            >
              {m === "url" ? "Remote URL" : m === "stdio" ? "Command" : "JSON"}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {mode !== "json" && <TextInput value={name} onChange={setName} placeholder="Name (shown in the connectors list)" width={440} />}
          {mode === "url" && (
            <>
              <TextInput value={url} onChange={setUrl} placeholder="https://mcp.example.com/mcp" width={440} />
              <textarea
                rows={2}
                placeholder="Optional headers, one per line — Authorization: Bearer sk-..."
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                style={{ width: 440, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text)", fontSize: TEXT.base, fontFamily: MONO }}
              />
            </>
          )}
          {mode === "stdio" && (
            <>
              <TextInput value={command} onChange={setCommand} placeholder="Command, e.g. npx" width={440} />
              <TextInput value={args} onChange={setArgs} placeholder="Args (space separated)" width={440} />
            </>
          )}
          {mode === "json" && (
            <textarea
              rows={8}
              placeholder={'{\n  "mcpServers": {\n    "my-server": { "command": "npx", "args": ["-y", "some-mcp-server"] }\n  }\n}'}
              value={json}
              onChange={(e) => setJson(e.target.value)}
              style={{ width: 440, padding: 10, borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text)", fontSize: 12.5, fontFamily: MONO }}
            />
          )}
        </div>
        {state !== "idle" && (
          <div
            style={{
              marginTop: 12,
              padding: "9px 12px",
              borderRadius: 6,
              fontSize: TEXT.sm,
              whiteSpace: "pre-wrap",
              background: state === "error" ? "rgba(220,38,38,0.1)" : state === "ok" ? "rgba(16,163,74,0.12)" : "var(--color-bg)",
              color: state === "error" ? "var(--color-error)" : state === "ok" ? "#0f7a4f" : "var(--color-text-secondary)",
            }}
          >
            {state === "testing" ? "Testing connection…" : message}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={{ border: "1px solid var(--color-border)", borderRadius: 6, background: "transparent", color: "var(--color-text)", cursor: "pointer", padding: "6px 14px" }}>
            Cancel
          </button>
          <SmallButton
            disabled={state === "testing" || (mode === "json" ? !json.trim() : !name.trim() || (mode === "url" ? !url.trim() : !command.trim()))}
            onClick={mode === "json" ? addAndTestJson : addAndTest}
          >
            {state === "testing" ? "Testing…" : "Add & test"}
          </SmallButton>
        </div>
      </div>
    </div>
  );
}

function McpPanel() {
  const [servers, setServers] = useState<OwnedMcpServer[] | null>(null);
  const [showModal, setShowModal] = useState(false);

  function refresh() {
    void window.metaharn.listOwnedMcpServers().then(setServers);
  }
  useEffect(refresh, []);

  return (
    <>
      <WorkspaceTrustRow />
      <div style={{ padding: SPACE.lg, borderBottom: "1px solid var(--color-border)" }}>
        <SmallButton onClick={() => setShowModal(true)}>+ Add custom connector</SmallButton>
      </div>
      {servers?.length === 0 && <EmptyRow>No connectors yet.</EmptyRow>}
      {servers?.map((s) => (
        <ListRow key={s.name} title={s.name} sub={s.transport === "http" ? s.url : `${s.command} ${s.args.join(" ")}`}>
          <IconButton danger label="Remove connector" onClick={() => void window.metaharn.deleteOwnedMcpServer(s.name).then(refresh)}>
            <TrashIcon size={14} />
          </IconButton>
        </ListRow>
      ))}
      {showModal && (
        <AddConnectorModal
          onClose={() => setShowModal(false)}
          onSaved={() => {
            setShowModal(false);
            refresh();
          }}
        />
      )}
    </>
  );
}

// -- Automations -------------------------------------------------------------------------

function AutomationsPanel() {
  const [tasks, setTasks] = useState<OwnedAutomation[] | null>(null);
  const [form, setForm] = useState({ title: "", instructions: "", workspace: "", cron: "0 9 * * *" });

  function refresh() {
    void window.metaharn.listOwnedAutomations().then(setTasks);
  }
  useEffect(refresh, []);

  return (
    <>
      <div style={{ padding: SPACE.lg, borderBottom: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: SPACE.sm }}>
        <div style={{ display: "flex", gap: SPACE.sm }}>
          <TextInput value={form.title} onChange={(v) => setForm({ ...form, title: v })} placeholder="Title" width={180} />
          <TextInput value={form.workspace} onChange={(v) => setForm({ ...form, workspace: v })} placeholder="Workspace path" width={260} />
          <TextInput value={form.cron} onChange={(v) => setForm({ ...form, cron: v })} placeholder="Cron" width={110} />
        </div>
        <div style={{ display: "flex", gap: SPACE.sm }}>
          <TextInput value={form.instructions} onChange={(v) => setForm({ ...form, instructions: v })} placeholder="Instructions for the agent…" width={460} />
          <SmallButton
            disabled={!form.title.trim() || !form.instructions.trim() || !form.workspace.trim()}
            onClick={() => {
              const schedule: OwnedAutomationSchedule = { kind: "cron", cron: form.cron, fireAt: null, timezone: "local" };
              void window.metaharn.createOwnedAutomation({ title: form.title, instructions: form.instructions, workspace: form.workspace, schedule }).then(() => {
                setForm({ title: "", instructions: "", workspace: "", cron: "0 9 * * *" });
                refresh();
              });
            }}
          >
            Create
          </SmallButton>
        </div>
      </div>
      {tasks?.length === 0 && <EmptyRow>No automations yet.</EmptyRow>}
      {tasks?.map((t) => (
        <ListRow key={t.id} title={t.title} sub={`${t.schedule} · ${t.runCount} run${t.runCount === 1 ? "" : "s"}`}>
          <IconButton label="Run now" onClick={() => void window.metaharn.runOwnedAutomationNow(t.id).then(refresh)}>
            <PlayIcon size={13} />
          </IconButton>
          <Toggle
            on={t.enabled}
            label={t.enabled ? "Pause automation" : "Resume automation"}
            onClick={() => void window.metaharn.setOwnedAutomationEnabled(t.id, !t.enabled).then(refresh)}
          />
          <IconButton danger label="Delete automation" onClick={() => void window.metaharn.deleteOwnedAutomation(t.id).then(refresh)}>
            <TrashIcon size={14} />
          </IconButton>
        </ListRow>
      ))}
    </>
  );
}

// -- Root: one Section, tabbed inside it — mirrors apps/web/src/Settings.tsx's grouping
// (General / Models / Memory / MCP servers / Automations) instead of five separate cards. --

export default function OwnedEngineSettings() {
  const [tab, setTab] = useState<Tab>("general");
  return (
    <Section title="Owned Engine">
      <div style={{ padding: `${SPACE.sm}px ${SPACE.lg}px`, borderBottom: "1px solid var(--color-border)" }}>
        <SegmentedControl options={TABS} value={tab} onChange={setTab} />
      </div>
      {tab === "general" && <GeneralPanel />}
      {tab === "models" && <ModelsPanel />}
      {tab === "memory" && <MemoryPanel />}
      {tab === "mcp" && <McpPanel />}
      {tab === "automations" && <AutomationsPanel />}
    </Section>
  );
}
