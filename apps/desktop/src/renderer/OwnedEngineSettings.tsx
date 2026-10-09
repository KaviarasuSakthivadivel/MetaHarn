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
import { Row, SPACE, TEXT } from "./ui.js";
import { ClockIcon, PlayIcon, PlugIcon, PlusIcon, TrashIcon } from "./icons.js";
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

/** `grow: true` makes the field a flexible flex child (`flex-basis` = `width`, with a sane
 * floor) instead of a fixed pixel box — ModelsPanel's per-provider field groups use this so an
 * input shares leftover row width with its sibling button rather than forcing the row to
 * overflow (see ProviderRow's own doc comment for the overflow bug this replaced). */
function TextInput({ value, onChange, placeholder, type = "text", width, grow }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string; width?: number; grow?: boolean }) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="metaharn-focus-ring"
      style={{
        width: grow ? undefined : (width ?? 200),
        flex: grow ? `1 1 ${width ?? 140}px` : undefined,
        minWidth: grow ? 110 : undefined,
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

/** Small translucent status pill, reused across panels (Models' "Configured", Automations'
 * "Active"/"Paused", MCP's "Trusted"/"Not trusted") instead of each inventing its own. `color`
 * is a CSS color (usually a var) — "good" states pass the session-status "working" green
 * (theme.css), the same hue ProjectsListPage's "● Active" pill already uses, rather than a new
 * one; neutral states pass `--color-text-muted`. */
function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        flexShrink: 0,
        fontSize: 10.5,
        fontWeight: 600,
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        borderRadius: 5,
        padding: "1px 7px",
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: color, display: "inline-block" }} />
      {children}
    </span>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: `${SPACE.md}px ${SPACE.lg}px`, fontSize: TEXT.sm, color: "var(--color-text-muted)" }}>{children}</div>;
}

function FormBar({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: SPACE.lg, borderBottom: "1px solid var(--color-border)", display: "flex", gap: SPACE.sm, flexWrap: "wrap" }}>{children}</div>;
}

// -- General -------------------------------------------------------------------------------

export function GeneralPanel() {
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

/** One provider as a collapsed, scannable row by default — icon, name, a "Configured" pill or
 * "Not set up"/base-url subtitle, nothing else. The whole earlier design (both the cramped
 * single-line version a screenshot caught overflowing, AND the "wrapping groups" fix that
 * followed it) showed an API-key input box for every one of the ~10 providers at once, all the
 * time — the real complaint a redesign needs to answer isn't "the boxes overlap," it's "why are
 * there ten text boxes on screen when I'm here to set up one provider." So: collapsed by
 * default, click a row to reveal ONLY that provider's key/model fields below it, click again (or
 * open a different row) to close it. At most one text box per provider ever shows, and usually
 * zero. */
function ProviderRow({
  provider,
  expanded,
  onToggle,
  keyDraft,
  modelDraft,
  onKeyDraftChange,
  onModelDraftChange,
  onSaveKey,
  onRemoveKey,
  onSetDefaultModel,
}: {
  provider: OwnedProviderStatus;
  expanded: boolean;
  onToggle: () => void;
  keyDraft: string;
  modelDraft: string;
  onKeyDraftChange: (v: string) => void;
  onModelDraftChange: (v: string) => void;
  onSaveKey: () => void;
  onRemoveKey: () => void;
  onSetDefaultModel: () => void;
}) {
  const p = provider;
  return (
    <div style={{ borderBottom: "1px solid var(--color-border)" }}>
      <button
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: SPACE.sm,
          width: "100%",
          textAlign: "left",
          padding: `${SPACE.md}px ${SPACE.lg}px`,
          border: "none",
          background: "transparent",
          color: "var(--color-text)",
          cursor: "pointer",
        }}
      >
        <ProviderIcon name={p.name} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: TEXT.base, fontWeight: 600 }}>{p.displayName}</span>
            {p.configured && !p.noKeyNeeded && <Pill color="var(--color-status-working)">Configured</Pill>}
          </div>
          {(p.noKeyNeeded || !p.configured) && (
            <div
              style={{
                fontSize: TEXT.sm,
                color: "var(--color-text-muted)",
                marginTop: 1,
                fontFamily: p.noKeyNeeded ? MONO : undefined,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {p.noKeyNeeded ? p.baseUrl : "Not set up"}
            </div>
          )}
        </div>
        <span style={{ color: "var(--color-text-muted)", fontSize: 10, flexShrink: 0, transform: expanded ? "rotate(180deg)" : undefined, transition: "transform 0.12s ease" }}>▾</span>
      </button>

      {expanded && (
        <div style={{ padding: `0 ${SPACE.lg}px ${SPACE.lg}px`, display: "flex", flexDirection: "column", gap: SPACE.sm }}>
          {!p.noKeyNeeded && (
            <div style={{ display: "flex", alignItems: "center", gap: SPACE.xs, flexWrap: "wrap" }}>
              <TextInput type="password" placeholder={p.configured ? "•••••• (replace)" : "API key"} value={keyDraft} onChange={onKeyDraftChange} width={200} grow />
              <SmallButton disabled={!keyDraft} onClick={onSaveKey}>
                Save
              </SmallButton>
              {p.configured && (
                <SmallButton danger onClick={onRemoveKey}>
                  Remove
                </SmallButton>
              )}
            </div>
          )}
          {p.configured && (
            <div style={{ display: "flex", alignItems: "center", gap: SPACE.xs, flexWrap: "wrap" }}>
              <TextInput placeholder={MODEL_PLACEHOLDER[p.name] ?? "model id"} value={modelDraft} onChange={onModelDraftChange} width={200} grow />
              <SmallButton danger disabled={!modelDraft} onClick={onSetDefaultModel}>
                Set default
              </SmallButton>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ModelsPanel() {
  const [providers, setProviders] = useState<OwnedProviderStatus[] | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  // At most one provider's fields are visible at a time (accordion, not independent per-row
  // toggles) — closing one before opening the next is what actually keeps the panel calm as the
  // provider count grows, rather than just moving the clutter behind a click.
  const [expanded, setExpanded] = useState<string | null>(null);

  function refresh() {
    void window.metaharn.listOwnedProviders().then(setProviders);
  }
  useEffect(refresh, []);

  return (
    <>
      {providers === null && <EmptyRow>Loading…</EmptyRow>}
      {providers?.map((p) => (
        <ProviderRow
          key={p.name}
          provider={p}
          expanded={expanded === p.name}
          onToggle={() => setExpanded((cur) => (cur === p.name ? null : p.name))}
          keyDraft={keyDrafts[p.name] ?? ""}
          modelDraft={modelDrafts[p.name] ?? ""}
          onKeyDraftChange={(v) => setKeyDrafts((d) => ({ ...d, [p.name]: v }))}
          onModelDraftChange={(v) => setModelDrafts((d) => ({ ...d, [p.name]: v }))}
          onSaveKey={() =>
            void window.metaharn.setOwnedProvider(p.name, { apiKey: keyDrafts[p.name] }).then(() => {
              setKeyDrafts((d) => ({ ...d, [p.name]: "" }));
              setExpanded(null);
              refresh();
            })
          }
          onRemoveKey={() =>
            void window.metaharn.deleteOwnedProviderKey(p.name).then(() => {
              setExpanded(null);
              refresh();
            })
          }
          onSetDefaultModel={() =>
            void window.metaharn.setOwnedDefaultModel(p.name, modelDrafts[p.name]).then(() => {
              setExpanded(null);
              refresh();
            })
          }
        />
      ))}
    </>
  );
}

// -- Memory ------------------------------------------------------------------------------

export function MemoryPanel() {
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
      <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap" }}>
        <TextInput
          value={workspace}
          onChange={(v) => {
            setWorkspace(v);
            check(v);
          }}
          placeholder="Workspace path"
          width={280}
          grow
        />
        {trusted !== null && (
          <>
            {trusted ? <Pill color="var(--color-status-working)">Trusted</Pill> : <Pill color="var(--color-text-muted)">Not trusted</Pill>}
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
                className="metaharn-focus-ring"
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
              className="metaharn-focus-ring"
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

export function McpPanel() {
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
        <SmallButton onClick={() => setShowModal(true)}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <PlusIcon size={12} /> Add custom connector
          </span>
        </SmallButton>
      </div>
      {servers?.length === 0 && <EmptyRow>No connectors yet — add one above, or point a workspace at its own trusted mcp.json.</EmptyRow>}
      {servers?.map((s) => (
        <ListRow key={s.name} title={s.name} sub={s.transport === "http" ? s.url : `${s.command} ${s.args.join(" ")}`} icon={<PlugIcon size={16} />}>
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

/** Same "hidden until requested" shape as AddConnectorModal — the previous version kept 4
 * always-visible fields (Title / Workspace / Cron / Instructions) permanently open above the
 * list, the exact clutter pattern the Models panel got called out for, just with a form instead
 * of 10 repeated key inputs. Stacked fields here too (not cramped side by side at 180/260/110px,
 * which left "Cron" too narrow to read what you typed), with the cron field's own example/help
 * text since it's the one input here with a format a user might not already know. */
function AddAutomationModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [cron, setCron] = useState("0 9 * * *");
  const [instructions, setInstructions] = useState("");

  const canCreate = title.trim() && workspace.trim() && instructions.trim();

  function create() {
    if (!canCreate) return;
    const schedule: OwnedAutomationSchedule = { kind: "cron", cron, fireAt: null, timezone: "local" };
    void window.metaharn.createOwnedAutomation({ title: title.trim(), instructions: instructions.trim(), workspace: workspace.trim(), schedule }).then(onSaved);
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--color-bg-elevated)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 20, width: 460, boxShadow: "0 8px 24px rgba(0,0,0,0.25)" }}>
        <div style={{ fontSize: TEXT.lg, fontWeight: 600, marginBottom: 14 }}>New automation</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <TextInput value={title} onChange={setTitle} placeholder="Title" width={420} />
          <TextInput value={workspace} onChange={setWorkspace} placeholder="Workspace path" width={420} />
          <div>
            <TextInput value={cron} onChange={setCron} placeholder="Cron" width={420} />
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 4, fontFamily: MONO }}>e.g. "0 9 * * *" — every day at 9am, local time</div>
          </div>
          <textarea
            rows={4}
            placeholder="Instructions for the agent…"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className="metaharn-focus-ring"
            style={{ width: 420, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text)", fontSize: TEXT.base, fontFamily: "inherit", resize: "vertical" }}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={{ border: "1px solid var(--color-border)", borderRadius: 6, background: "transparent", color: "var(--color-text)", cursor: "pointer", padding: "6px 14px" }}>
            Cancel
          </button>
          <SmallButton disabled={!canCreate} onClick={create}>
            Create
          </SmallButton>
        </div>
      </div>
    </div>
  );
}

function AutomationRow({
  automation,
  onRunNow,
  onToggle,
  onDelete,
}: {
  automation: OwnedAutomation;
  onRunNow: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const t = automation;
  return (
    <div
      className="metaharn-list-row"
      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: `${SPACE.md}px ${SPACE.lg}px`, borderBottom: "1px solid var(--color-border)", gap: SPACE.md }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, minWidth: 0 }}>
        <ClockIcon size={16} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: TEXT.base, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
            {t.enabled ? <Pill color="var(--color-status-working)">Active</Pill> : <Pill color="var(--color-text-muted)">Paused</Pill>}
          </div>
          <div style={{ fontSize: TEXT.sm, color: "var(--color-text-secondary)", marginTop: 2, fontFamily: MONO, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t.schedule} · {t.runCount} run{t.runCount === 1 ? "" : "s"}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: SPACE.xs, flexShrink: 0, alignItems: "center" }}>
        <IconButton label="Run now" onClick={onRunNow}>
          <PlayIcon size={13} />
        </IconButton>
        <Toggle on={t.enabled} label={t.enabled ? "Pause automation" : "Resume automation"} onClick={onToggle} />
        <IconButton danger label="Delete automation" onClick={onDelete}>
          <TrashIcon size={14} />
        </IconButton>
      </div>
    </div>
  );
}

export function AutomationsPanel() {
  const [tasks, setTasks] = useState<OwnedAutomation[] | null>(null);
  const [showModal, setShowModal] = useState(false);

  function refresh() {
    void window.metaharn.listOwnedAutomations().then(setTasks);
  }
  useEffect(refresh, []);

  return (
    <>
      <div style={{ padding: SPACE.lg, borderBottom: "1px solid var(--color-border)" }}>
        <SmallButton onClick={() => setShowModal(true)}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <PlusIcon size={12} /> New automation
          </span>
        </SmallButton>
      </div>
      {tasks?.length === 0 && <EmptyRow>No automations yet — add one above to run the agent on a schedule.</EmptyRow>}
      {tasks?.map((t) => (
        <AutomationRow
          key={t.id}
          automation={t}
          onRunNow={() => void window.metaharn.runOwnedAutomationNow(t.id).then(refresh)}
          onToggle={() => void window.metaharn.setOwnedAutomationEnabled(t.id, !t.enabled).then(refresh)}
          onDelete={() => void window.metaharn.deleteOwnedAutomation(t.id).then(refresh)}
        />
      ))}
      {showModal && (
        <AddAutomationModal
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

// Each panel above (GeneralPanel / ModelsPanel / MemoryPanel / McpPanel / AutomationsPanel) is
// its own named export — SettingsPage.tsx's left-nav sidebar hosts them directly as top-level
// destinations now, grouped under "Owned Engine", instead of this file owning a second tab bar
// nested inside one of SettingsPage's own Sections (where it read as subordinate to things like
// "Agent CLIs" even though it's a peer in scope). Mirrors apps/web/src/Settings.tsx's grouping
// (General / Models / Memory / MCP servers / Automations), just surfaced via the shared nav
// instead of a local SegmentedControl.
