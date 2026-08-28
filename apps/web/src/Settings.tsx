import { useEffect, useState } from "react";
import * as client from "./client.js";
import type { Automation, AutomationSchedule, GeneralSettings, MemoryItem, MemoryScope, ProviderStatus } from "./client.js";
// Real vendor marks, not two-letter initials — @lobehub/icons-static-svg (MIT, built for exactly
// this: AI-provider logos) is the only icon set checked that actually covers all ten providers.
// simple-icons was tried first and rejected: it has no entry at all for OpenAI, Groq, xAI,
// Fireworks, or Together AI (confirmed against its own data file, not assumed). SVG, not a
// downloaded PNG per company site, is what actually answers "proper for each resolution" — a
// vector has no resolution to be wrong at, where a raster logo would need @1x/@2x/@3x variants
// and still go soft on a 4K display. `-color` variants (their real multi-color brand rendering)
// are used where the package has one; the rest are the vendor's own monochrome mark (`fill:
// currentColor`, styled dark here) — not a compromise, several of these (OpenAI, Groq) are
// monochrome by design in their real branding, not a lesser version of a color logo that exists.
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
import geminiColorSvg from "@lobehub/icons-static-svg/icons/gemini-color.svg?raw";
import bedrockColorSvg from "@lobehub/icons-static-svg/icons/bedrock-color.svg?raw";
import zhipuColorSvg from "@lobehub/icons-static-svg/icons/zhipu-color.svg?raw";
import kimiColorSvg from "@lobehub/icons-static-svg/icons/kimi-color.svg?raw";
import minimaxColorSvg from "@lobehub/icons-static-svg/icons/minimax-color.svg?raw";
import qwenColorSvg from "@lobehub/icons-static-svg/icons/qwen-color.svg?raw";
import metaColorSvg from "@lobehub/icons-static-svg/icons/meta-color.svg?raw";

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
  gemini: geminiColorSvg,
  bedrock: bedrockColorSvg,
  zai: zhipuColorSvg,
  kimi: kimiColorSvg,
  minimax: minimaxColorSvg,
  qwen: qwenColorSvg,
  meta: metaColorSvg,
};

/** Renders a vendor's real SVG mark from PROVIDER_ICON_SVG — build-time trusted content (an
 * installed npm package, never user input), so innerHTML here carries no XSS risk. */
function ProviderIcon({ name }: { name: string }) {
  const svg = PROVIDER_ICON_SVG[name];
  if (!svg) return <span style={{ fontWeight: 800, fontSize: 13 }}>{name.slice(0, 2).toUpperCase()}</span>;
  return <span className="provider-icon-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
}

type Tab = "general" | "models" | "memory" | "automations";

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

function IconPlay() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <polygon points="6 3 21 12 6 21 6 3" />
    </svg>
  );
}

function relativeTime(epochSeconds: number | null): string {
  if (!epochSeconds) return "never";
  const diff = Date.now() / 1000 - epochSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function GeneralTab() {
  const [settings, setSettings] = useState<GeneralSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client.getSettings().then(setSettings).catch(() => {});
  }, []);

  async function toggleAutoApprove() {
    if (!settings) return;
    setBusy(true);
    try {
      const next = !settings.autoApprove;
      await client.setAutoApprove(next);
      setSettings({ ...settings, autoApprove: next });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>General</h2>
      <p className="desc">Session-wide defaults for this machine.</p>
      {settings && (
        <>
          <div className="default-model-banner">
            Default model for new sessions: <strong>{settings.defaultModel.provider}:{settings.defaultModel.modelId}</strong> — change it from a provider's card on the Models tab.
          </div>
          <div className="toggle-row">
            <div className="toggle-row-text">
              <div className="toggle-row-title">Auto-approve mode</div>
              <div className="toggle-row-desc">
                An LLM reviewer judges routine tool approvals before they'd otherwise interrupt you — only genuinely questionable actions still ask. Off by default.
              </div>
            </div>
            <button className={`switch${settings.autoApprove ? " on" : ""}`} disabled={busy} onClick={toggleAutoApprove} aria-label="Toggle auto-approve mode" />
          </div>
        </>
      )}
    </>
  );
}

interface CuratedModel {
  id: string;
  label: string;
}

/** Curated, agent-capable models per provider — what a provider's detail page lists under
 * "Included models." Every id here is a real identifier that provider's API accepts today; kept
 * short per provider on purpose (2-4 entries) rather than mirroring a vendor's entire catalog,
 * since this is "models actually worth running an agent on," not an exhaustive model directory. */
const PROVIDER_MODELS: Record<string, CuratedModel[]> = {
  anthropic: [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
    { id: "o3", label: "o3" },
  ],
  ollama: [
    { id: "llama3.3", label: "Llama 3.3" },
    { id: "qwen2.5", label: "Qwen 2.5" },
    { id: "mistral", label: "Mistral" },
  ],
  openrouter: [
    { id: "anthropic/claude-opus-5", label: "Claude Opus 5" },
    { id: "openai/gpt-4o", label: "GPT-4o" },
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
  ],
  together: [
    { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", label: "Llama 3.3 70B Turbo" },
    { id: "Qwen/Qwen2.5-72B-Instruct-Turbo", label: "Qwen 2.5 72B Turbo" },
  ],
  fireworks: [
    { id: "accounts/fireworks/models/llama-v3p3-70b-instruct", label: "Llama 3.3 70B" },
    { id: "accounts/fireworks/models/qwen2p5-72b-instruct", label: "Qwen 2.5 72B" },
  ],
  deepseek: [
    { id: "deepseek-chat", label: "DeepSeek Chat" },
    { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
  ],
  groq: [
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
    { id: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
  ],
  mistral: [
    { id: "mistral-large-latest", label: "Mistral Large" },
    { id: "mistral-small-latest", label: "Mistral Small" },
    { id: "codestral-latest", label: "Codestral" },
  ],
  xai: [
    { id: "grok-4", label: "Grok 4" },
    { id: "grok-4-fast", label: "Grok 4 Fast" },
  ],
  gemini: [
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
  // Claude-family only — see BedrockProvider's own module doc for why this integration
  // doesn't reach Bedrock's other models (Nova, Llama, Mistral, …) via the Converse API.
  bedrock: [
    { id: "anthropic.claude-sonnet-4-6-v1:0", label: "Claude Sonnet 4.6" },
    { id: "anthropic.claude-haiku-4-5-v1:0", label: "Claude Haiku 4.5" },
  ],
  zai: [{ id: "glm-5.2", label: "GLM-5.2" }],
  kimi: [{ id: "kimi-k2.6", label: "Kimi K2.6" }],
  minimax: [{ id: "MiniMax-M2.5", label: "MiniMax M2.5" }],
  qwen: [{ id: "qwen3-max", label: "Qwen3 Max" }],
  meta: [{ id: "muse-spark-1.1", label: "Muse Spark 1.1" }],
};

const MODEL_PLACEHOLDER: Record<string, string> = Object.fromEntries(
  Object.entries(PROVIDER_MODELS).map(([provider, models]) => [provider, models[0]?.id ?? ""]),
);

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  anthropic: "Claude's own API — the model family this app is built around.",
  openai: "GPT and o-series models via OpenAI's own API.",
  ollama: "Runs models locally on this machine — no API key, no data leaves your computer.",
  openrouter: "One key, routed to whichever vendor's model you pick per call.",
  together: "Open-weight models (Llama, Qwen, and more), hosted and fast.",
  fireworks: "Fast-inference hosting for open-weight models.",
  deepseek: "DeepSeek's own API — strong reasoning models at low cost.",
  groq: "Open-weight models served on Groq's LPU hardware — very low latency.",
  mistral: "Mistral's own API, including Codestral for code.",
  xai: "Grok models via xAI's own API.",
  gemini: "Google's own Gemini API — thinking models by default, native vision and PDF support.",
  bedrock: "Claude models running inside your own AWS account, via Anthropic's native Bedrock path.",
  zai: "Z AI's own API — the GLM model family.",
  kimi: "Moonshot AI's own API — the Kimi model family.",
  minimax: "MiniMax's own API.",
  qwen: "Alibaba's own API — the Qwen model family.",
  meta: "Meta's own Model API (public preview) — the Muse Spark family.",
};

function ModelsTab() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [defaultModel, setDefaultModelState] = useState<{ provider: string; modelId: string } | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(null);

  function refresh() {
    client.listProviders().then((r) => setProviders(r.providers)).catch((err) => setError((err as Error).message));
    client.getSettings().then((s) => setDefaultModelState(s.defaultModel)).catch(() => {});
  }

  useEffect(refresh, []);

  async function makeDefault(provider: string, modelId: string) {
    await client.setDefaultModel(provider, modelId);
    refresh();
  }

  if (selected) {
    const provider = providers.find((p) => p.name === selected);
    if (!provider) {
      setSelected(null);
      return null;
    }
    return <ProviderDetailPage provider={provider} defaultModel={defaultModel} onBack={() => setSelected(null)} onMakeDefault={makeDefault} onSaved={refresh} />;
  }

  return (
    <>
      <h2>Models</h2>
      <p className="desc">Connect the providers your sessions can use. Keys are stored locally on this machine and never sent anywhere but the provider itself.</p>
      {defaultModel && (
        <div className="default-model-banner">
          Default for new sessions: <strong>{defaultModel.provider}:{defaultModel.modelId}</strong>
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}
      <div className="provider-grid provider-grid-bold">
        {providers.map((p) => (
          <button key={p.name} className={`provider-card provider-card-clickable${p.configured ? " configured" : ""}`} onClick={() => setSelected(p.name)}>
            <div className="provider-card-top">
              <div className="provider-icon provider-icon-lg">
                <ProviderIcon name={p.name} />
              </div>
              <div>
                <div className="provider-name provider-name-lg">{p.displayName}</div>
                <span className={`provider-status ${p.configured ? "configured" : "unset"}`}>{p.configured ? "● Ready" : "Not set up"}</span>
              </div>
              <span className="provider-card-chevron">›</span>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

type BedrockAuthMethod = "api_key" | "profile" | "iam";

/** AWS Bedrock's own form — three mutually exclusive auth methods (mirrors OpenWorker's
 * Settings > Models > AWS Bedrock descriptor exactly), not the single apiKey/baseUrl pair
 * every other provider's card uses. */
function BedrockFields({ provider, onSaved }: { provider: ProviderStatus; onSaved: () => void }) {
  const [authMethod, setAuthMethod] = useState<BedrockAuthMethod>("api_key");
  const [region, setRegion] = useState("");
  const [bedrockApiKey, setBedrockApiKey] = useState("");
  const [awsProfile, setAwsProfile] = useState("");
  const [awsAccessKeyId, setAwsAccessKeyId] = useState("");
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState("");
  const [awsSessionToken, setAwsSessionToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await client.setProvider("bedrock", {
        region: region || undefined,
        authMethod,
        ...(authMethod === "api_key" ? { bedrockApiKey } : {}),
        ...(authMethod === "profile" ? { awsProfile } : {}),
        ...(authMethod === "iam" ? { awsAccessKeyId, awsSecretAccessKey, awsSessionToken } : {}),
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await client.deleteProviderKey("bedrock");
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 24, maxWidth: 640 }}>
      {error && <div className="error-banner">{error}</div>}

      <div className="field-label">AWS region</div>
      <p className="desc" style={{ margin: "0 0 8px" }}>The region your Bedrock model access is enabled in.</p>
      <div className="field-row">
        <input placeholder="us-east-1" value={region} onChange={(e) => setRegion(e.target.value)} style={{ fontFamily: "var(--font-mono)" }} />
      </div>

      <div className="field-label" style={{ marginTop: 18 }}>Connect with</div>
      <div className="field-row">
        <select value={authMethod} onChange={(e) => setAuthMethod(e.target.value as BedrockAuthMethod)}>
          <option value="api_key">Bedrock API key — easiest</option>
          <option value="profile">AWS profile</option>
          <option value="iam">IAM keys</option>
        </select>
      </div>

      {authMethod === "api_key" && (
        <>
          <div className="field-label" style={{ marginTop: 18 }}>Bedrock API key</div>
          <p className="desc" style={{ margin: "0 0 8px" }}>A single key generated on the Bedrock console — no AWS CLI or IAM setup needed.</p>
          <div className="field-row">
            <input
              type="password"
              placeholder="ABSK…"
              value={bedrockApiKey}
              onChange={(e) => setBedrockApiKey(e.target.value)}
              style={{ fontFamily: "var(--font-mono)" }}
            />
          </div>
        </>
      )}
      {authMethod === "profile" && (
        <>
          <div className="field-label" style={{ marginTop: 18 }}>AWS profile</div>
          <p className="desc" style={{ margin: "0 0 8px" }}>
            Uses a named profile from ~/.aws — works with <code className="inline-code">aws configure</code> and{" "}
            <code className="inline-code">aws sso login</code>. Leave blank to use your default AWS credentials.
          </p>
          <div className="field-row">
            <input placeholder="default" value={awsProfile} onChange={(e) => setAwsProfile(e.target.value)} style={{ fontFamily: "var(--font-mono)" }} />
          </div>
        </>
      )}
      {authMethod === "iam" && (
        <>
          <div className="field-label" style={{ marginTop: 18 }}>Access key ID</div>
          <div className="field-row">
            <input placeholder="AKIA…" value={awsAccessKeyId} onChange={(e) => setAwsAccessKeyId(e.target.value)} style={{ fontFamily: "var(--font-mono)" }} />
          </div>
          <div className="field-label" style={{ marginTop: 18 }}>Secret access key</div>
          <div className="field-row">
            <input type="password" value={awsSecretAccessKey} onChange={(e) => setAwsSecretAccessKey(e.target.value)} style={{ fontFamily: "var(--font-mono)" }} />
          </div>
          <div className="field-label" style={{ marginTop: 18 }}>Session token (STS only, optional)</div>
          <p className="desc" style={{ margin: "0 0 8px" }}>For temporary STS credentials.</p>
          <div className="field-row">
            <input type="password" value={awsSessionToken} onChange={(e) => setAwsSessionToken(e.target.value)} style={{ fontFamily: "var(--font-mono)" }} />
          </div>
        </>
      )}

      <div className="field-row" style={{ marginTop: 20, justifyContent: "flex-start" }}>
        <button className="btn-primary accent" style={{ flex: "none" }} disabled={busy} onClick={save}>
          Save
        </button>
        {provider.configured && (
          <button className="link-danger" disabled={busy} onClick={clear}>
            Remove credentials
          </button>
        )}
      </div>
    </div>
  );
}

function ProviderDetailPage({
  provider,
  defaultModel,
  onBack,
  onMakeDefault,
  onSaved,
}: {
  provider: ProviderStatus;
  defaultModel: { provider: string; modelId: string } | null;
  onBack: () => void;
  onMakeDefault: (provider: string, modelId: string) => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const models = PROVIDER_MODELS[provider.name] ?? [];

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await client.setProvider(provider.name, { apiKey: draft });
      setDraft("");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await client.deleteProviderKey(provider.name);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>Models</h2>
      <p className="desc">Providers and the models offered in the composer's picker. Keys are stored locally on this machine and never sent anywhere but the provider itself.</p>
      <button className="provider-back-link" onClick={onBack}>
        ‹ All providers
      </button>

      <div className="provider-detail-header">
        <div className="provider-icon provider-icon-xl">
          <ProviderIcon name={provider.name} />
        </div>
        <div>
          <div className="provider-name provider-name-xl">{provider.displayName}</div>
          <span className={`provider-status ${provider.configured ? "configured" : "unset"}`}>{provider.configured ? "● Ready" : "Not set up"}</span>
        </div>
      </div>
      {PROVIDER_DESCRIPTIONS[provider.name] && <p className="provider-detail-desc">{PROVIDER_DESCRIPTIONS[provider.name]}</p>}

      {error && <div className="error-banner">{error}</div>}

      {provider.noKeyNeeded ? (
        <div className="provider-no-key" style={{ marginTop: 20 }}>
          No API key needed — talks to {provider.baseUrl}.
        </div>
      ) : provider.name === "bedrock" ? (
        <BedrockFields provider={provider} onSaved={onSaved} />
      ) : (
        <div style={{ marginTop: 24, maxWidth: 640 }}>
          <div className="field-label">{provider.displayName} API key</div>
          <div className="field-row">
            <input
              type="password"
              placeholder={provider.configured ? "•••••••••••• (replace)" : "sk-..."}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              style={{ fontFamily: "var(--font-mono)" }}
            />
            <button className="btn-primary accent" style={{ flex: "none" }} disabled={busy || !draft} onClick={save}>
              Test
            </button>
          </div>
          {provider.configured && (
            <button className="link-danger" disabled={busy} onClick={clear}>
              Remove key
            </button>
          )}
        </div>
      )}

      {models.length > 0 && (
        <div className="models-picker-section">
          <div className="settings-eyebrow">Included models</div>
          <p className="desc" style={{ marginBottom: 16 }}>
            Curated, agent-capable models this provider serves — add your key above to enable them.
          </p>
          {models.map((m) => {
            const isDefault = defaultModel?.provider === provider.name && defaultModel?.modelId === m.id;
            return (
              <div className="list-card" key={m.id}>
                <div className="list-card-main">
                  <div className="list-card-title">{m.label}</div>
                  <div className="list-card-sub">{m.id}</div>
                </div>
                {isDefault ? (
                  <span className="default-pill">default</span>
                ) : (
                  <button
                    className="btn-sm"
                    style={{ background: "transparent", color: "var(--text-muted)", border: "1px solid var(--line)" }}
                    disabled={!provider.configured && !provider.noKeyNeeded}
                    onClick={() => onMakeDefault(provider.name, m.id)}
                  >
                    Set as default
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function MemoryTab({ workspace }: { workspace: string }) {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<MemoryScope>("workspace");

  function refresh() {
    client.listMemories().then((r) => setMemories(r.memories));
  }
  useEffect(refresh, []);

  async function add() {
    if (!content.trim()) return;
    await client.addMemory(content.trim(), scope, scope === "workspace" ? workspace : undefined);
    setContent("");
    refresh();
  }

  return (
    <>
      <h2>Memory</h2>
      <p className="desc">Durable facts the agent remembers across sessions — the same store its own `remember` tool writes to.</p>
      <div className="new-item-form">
        <textarea rows={2} placeholder="Add a memory (e.g. a preference or project fact)…" value={content} onChange={(e) => setContent(e.target.value)} />
        <div className="field-row">
          <select value={scope} onChange={(e) => setScope(e.target.value as MemoryScope)} style={{ flex: "none", width: 160 }}>
            <option value="workspace">This workspace</option>
            <option value="global">Global (all workspaces)</option>
          </select>
          <button className="btn-sm" style={{ flex: "none" }} onClick={add}>
            Add memory
          </button>
        </div>
      </div>
      {memories.length === 0 && (
        <div className="empty-state">
          <h3>No memories yet</h3>
          <p>Facts the agent saves during chats — or ones you add here — will show up in this list.</p>
        </div>
      )}
      {memories.map((m) => (
        <div className="list-card" key={m.id}>
          <div className="list-card-main">
            <div className="list-card-title">{m.content}</div>
            <div className="list-card-sub">
              {m.scope}
              {m.workspace ? ` · ${m.workspace}` : ""}
            </div>
          </div>
          <div className="list-card-actions">
            <button className="list-card-icon-btn danger" aria-label="Delete memory" title="Delete" onClick={() => client.deleteMemory(m.id).then(refresh)}>
              <IconTrash />
            </button>
          </div>
        </div>
      ))}
    </>
  );
}


function AutomationsTab({ workspace }: { workspace: string }) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", instructions: "", kind: "cron" as "cron" | "once", cron: "0 9 * * *", fireAt: "" });

  function refresh() {
    client.listAutomations().then((r) => setAutomations(r.automations));
  }
  useEffect(refresh, []);

  async function create() {
    if (!form.title.trim() || !form.instructions.trim()) return;
    const schedule: AutomationSchedule =
      form.kind === "cron"
        ? { kind: "cron", cron: form.cron, fireAt: null, timezone: "local" }
        : { kind: "once", cron: null, fireAt: form.fireAt, timezone: "local" };
    await client.createAutomation({ title: form.title, instructions: form.instructions, workspace, schedule });
    setForm({ title: "", instructions: "", kind: "cron", cron: "0 9 * * *", fireAt: "" });
    setShowForm(false);
    refresh();
  }

  return (
    <>
      <h2>Automations</h2>
      <p className="desc">Standing tasks that run on a schedule in this workspace, unattended.</p>
      {!showForm && (
        <button className="btn-sm" style={{ marginBottom: 20 }} onClick={() => setShowForm(true)}>
          + New automation
        </button>
      )}
      {showForm && (
        <div className="new-item-form">
          <div className="field-row">
            <input placeholder="Title (e.g. Nightly changelog)" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="field-row">
            <textarea rows={3} placeholder="Instructions for the agent to run each time…" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
          </div>
          <div className="field-row">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "cron" | "once" })} style={{ flex: "none", width: 140 }}>
              <option value="cron">Repeating (cron)</option>
              <option value="once">One time</option>
            </select>
            {form.kind === "cron" ? (
              <input placeholder="Cron (m h dom mon dow)" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
            ) : (
              <input type="datetime-local" value={form.fireAt} onChange={(e) => setForm({ ...form, fireAt: e.target.value })} />
            )}
          </div>
          <div className="field-row" style={{ justifyContent: "flex-end" }}>
            <button className="btn-sm" style={{ flex: "none" }} onClick={create}>
              Create automation
            </button>
          </div>
        </div>
      )}
      {automations.length === 0 && (
        <div className="empty-state">
          <h3>No automations yet</h3>
          <p>Create a standing task and it'll run on its own schedule, no chat window needed.</p>
        </div>
      )}
      {automations.map((a) => (
        <div className="list-card" key={a.id} style={{ alignItems: "flex-start" }}>
          <div className="list-card-main">
            <div className="list-card-title">{a.title}</div>
            <div className="list-card-sub" style={{ fontFamily: "var(--font-body)" }}>
              {a.schedule} · last run {relativeTime(a.lastRun)} · {a.runCount} run{a.runCount === 1 ? "" : "s"}
            </div>
          </div>
          <div className="list-card-actions">
            <button className="list-card-icon-btn" aria-label="Run now" title="Run now" onClick={() => client.runAutomationNow(a.id).then(refresh)}>
              <IconPlay />
            </button>
            <button
              className={`switch${a.enabled ? " on" : ""}`}
              aria-label={a.enabled ? "Pause automation" : "Resume automation"}
              title={a.enabled ? "Enabled — click to pause" : "Paused — click to resume"}
              onClick={() => client.setAutomationEnabled(a.id, !a.enabled).then(refresh)}
            />
            <button className="list-card-icon-btn danger" aria-label="Delete automation" title="Delete" onClick={() => client.deleteAutomation(a.id).then(refresh)}>
              <IconTrash />
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

export default function Settings({ workspace, initialTab }: { workspace: string; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "general");
  const tabs: { id: Tab; label: string }[] = [
    { id: "general", label: "General" },
    { id: "models", label: "Models" },
    { id: "memory", label: "Memory" },
    { id: "automations", label: "Automations" },
  ];
  return (
    <div className="settings-screen">
      <div className="settings-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`settings-tab${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="settings-body">
        {tab === "general" && <GeneralTab />}
        {tab === "models" && <ModelsTab />}
        {tab === "memory" && <MemoryTab workspace={workspace} />}
        {tab === "automations" && <AutomationsTab workspace={workspace} />}
      </div>
    </div>
  );
}
