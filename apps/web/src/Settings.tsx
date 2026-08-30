import { useEffect, useState } from "react";
import * as client from "./client.js";
import type { Automation, AutomationSchedule, GeneralSettings, MemoryItem, MemoryScope, ProviderStatus } from "./client.js";
import { PROVIDER_DESCRIPTIONS, PROVIDER_MODELS, ProviderIcon } from "./providerCatalog.js";

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

function IconInfo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" strokeLinecap="round" />
      <line x1="12" y1="8" x2="12.01" y2="8" strokeLinecap="round" />
    </svg>
  );
}

function IconExternalLink() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="15 3 21 3 21 9" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="10" y1="14" x2="21" y2="3" strokeLinecap="round" />
    </svg>
  );
}

function IconWrench() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L2 19v3h3l7.3-7.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2-2 2.8-2.8Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconTerminal() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="4 6 9 12 4 18" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="12" y1="18" x2="20" y2="18" strokeLinecap="round" />
    </svg>
  );
}

function IconGlobe() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <path d="M12 3c2.5 2.6 4 6 4 9s-1.5 6.4-4 9c-2.5-2.6-4-6-4-9s1.5-6.4 4-9Z" />
    </svg>
  );
}

function IconEye() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
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

type TelemetryPreset = "self-hosted" | "cloud" | "custom";

interface TelemetryEndpoint {
  baseUrl: string;
  httpPort: number;
  grpcPort: number;
}

// Self-hosted matches `docker compose up -d` from https://github.com/lmnr-ai/lmnr's own
// docker-compose.yml exactly: 8000/8001 are that stack's ingestion ports, 5667 its dashboard
// (a different port on the same stack, not the same thing as the ingestion endpoint above).
// Cloud values are Laminar's own SDK defaults (https://laminar.sh/docs/sdk/typescript/
// instrumentation) — https, ports 443/8443.
const TELEMETRY_PRESETS: Record<Exclude<TelemetryPreset, "custom">, TelemetryEndpoint & { dashboardUrl: string; label: string }> = {
  "self-hosted": { baseUrl: "http://localhost", httpPort: 8000, grpcPort: 8001, dashboardUrl: "http://localhost:5667", label: "Self-hosted" },
  cloud: { baseUrl: "https://api.lmnr.ai", httpPort: 443, grpcPort: 8443, dashboardUrl: "https://www.lmnr.ai/projects", label: "Laminar Cloud" },
};

function detectPreset(endpoint: TelemetryEndpoint): TelemetryPreset {
  for (const key of ["self-hosted", "cloud"] as const) {
    const p = TELEMETRY_PRESETS[key];
    if (p.baseUrl === endpoint.baseUrl && p.httpPort === endpoint.httpPort && p.grpcPort === endpoint.grpcPort) return key;
  }
  return "custom";
}

function TelemetryCard({
  settings,
  uncoveredProviders,
  onSaved,
}: {
  settings: GeneralSettings;
  uncoveredProviders: string[];
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<TelemetryPreset>(() => detectPreset(settings.telemetryEndpoint));
  const [customDraft, setCustomDraft] = useState<TelemetryEndpoint>(settings.telemetryEndpoint);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function toggle() {
    setBusy(true);
    setError(undefined);
    try {
      await client.setTelemetry({ enabled: !settings.telemetryEnabled });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function applyPreset(name: Exclude<TelemetryPreset, "custom">) {
    setTab(name);
    setBusy(true);
    setError(undefined);
    try {
      const p = TELEMETRY_PRESETS[name];
      await client.setTelemetry({ baseUrl: p.baseUrl, httpPort: p.httpPort, grpcPort: p.grpcPort });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function selectCustom() {
    setCustomDraft(settings.telemetryEndpoint);
    setTab("custom");
  }

  async function saveCustomEndpoint() {
    setBusy(true);
    setError(undefined);
    try {
      await client.setTelemetry({ baseUrl: customDraft.baseUrl, httpPort: customDraft.httpPort, grpcPort: customDraft.grpcPort });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    if (!apiKeyDraft.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.setTelemetry({ apiKey: apiKeyDraft.trim() });
      setApiKeyDraft("");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const dashboardUrl = tab !== "custom" ? TELEMETRY_PRESETS[tab].dashboardUrl : undefined;

  return (
    <div className="settings-card">
      <div className="settings-card-top">
        <div>
          <div className="settings-card-heading">
            <span className="settings-card-title">Telemetry</span>
            <span className={`provider-status ${settings.telemetryEnabled ? "configured" : "unset"}`}>{settings.telemetryEnabled ? "● Active" : "Off"}</span>
          </div>
          <p className="desc settings-card-desc">
            Traces model calls to{" "}
            <a href="https://laminar.sh" target="_blank" rel="noreferrer noopener">
              Laminar
            </a>{" "}
            for debugging and observability. Request/response content leaves this machine when this is on.
          </p>
        </div>
        <button className={`switch${settings.telemetryEnabled ? " on" : ""}`} disabled={busy} onClick={toggle} aria-label="Toggle telemetry" />
      </div>

      {error && (
        <div className="error-banner" style={{ marginTop: 14 }}>
          {error}
        </div>
      )}

      <div className="settings-section-label">Endpoint</div>
      <div className="method-tabs" role="tablist" aria-label="Telemetry endpoint">
        <button type="button" role="tab" aria-selected={tab === "self-hosted"} className={`method-tab${tab === "self-hosted" ? " active" : ""}`} disabled={busy} onClick={() => applyPreset("self-hosted")}>
          Self-hosted
        </button>
        <button type="button" role="tab" aria-selected={tab === "cloud"} className={`method-tab${tab === "cloud" ? " active" : ""}`} disabled={busy} onClick={() => applyPreset("cloud")}>
          Laminar Cloud
        </button>
        <button type="button" role="tab" aria-selected={tab === "custom"} className={`method-tab${tab === "custom" ? " active" : ""}`} disabled={busy} onClick={selectCustom}>
          Custom
        </button>
      </div>

      {tab !== "custom" ? (
        <div className="telemetry-endpoint-row">
          <span className="telemetry-endpoint-url">
            {settings.telemetryEndpoint.baseUrl} · HTTP {settings.telemetryEndpoint.httpPort} · gRPC {settings.telemetryEndpoint.grpcPort}
          </span>
          {dashboardUrl && (
            <a className="telemetry-dashboard-link" href={dashboardUrl} target="_blank" rel="noreferrer noopener">
              Open dashboard <IconExternalLink />
            </a>
          )}
        </div>
      ) : (
        <>
          <div className="telemetry-field-row">
            <div>
              <div className="field-label">Base URL</div>
              <input
                value={customDraft.baseUrl}
                onChange={(e) => setCustomDraft({ ...customDraft, baseUrl: e.target.value })}
                style={{ fontFamily: "var(--font-mono)" }}
              />
            </div>
          </div>
          <div className="telemetry-field-row">
            <div>
              <div className="field-label">HTTP port</div>
              <input type="number" value={customDraft.httpPort} onChange={(e) => setCustomDraft({ ...customDraft, httpPort: Number(e.target.value) })} />
            </div>
            <div>
              <div className="field-label">gRPC port</div>
              <input type="number" value={customDraft.grpcPort} onChange={(e) => setCustomDraft({ ...customDraft, grpcPort: Number(e.target.value) })} />
            </div>
          </div>
          <button className="btn-sm" style={{ marginTop: 10 }} disabled={busy} onClick={saveCustomEndpoint}>
            Save endpoint
          </button>
        </>
      )}

      <div className="settings-section-label">Project API key</div>
      <div className="field-row">
        <input
          type="password"
          placeholder={settings.telemetryConfigured ? "•••••••••••• (replace)" : "Laminar project API key"}
          value={apiKeyDraft}
          onChange={(e) => setApiKeyDraft(e.target.value)}
          style={{ fontFamily: "var(--font-mono)" }}
        />
        <button className="btn-sm" style={{ flex: "none" }} disabled={busy || !apiKeyDraft.trim()} onClick={saveKey}>
          Save key
        </button>
      </div>

      {uncoveredProviders.length > 0 && (
        <div className="settings-note">
          <IconInfo />
          <span>
            Not traced: <strong>{uncoveredProviders.join(", ")}</strong> — {uncoveredProviders.length === 1 ? "uses" : "use"} a client Laminar doesn't instrument.
          </span>
        </div>
      )}
    </div>
  );
}

function GeneralTab() {
  const [settings, setSettings] = useState<GeneralSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncoveredProviders, setUncoveredProviders] = useState<string[]>([]);

  function refresh() {
    client.getSettings().then(setSettings).catch(() => {});
    client
      .listProviders()
      .then((r) => setUncoveredProviders(r.providers.filter((p) => !p.telemetryCovered).map((p) => p.displayName)))
      .catch(() => {});
  }
  useEffect(refresh, []);

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

          <TelemetryCard settings={settings} uncoveredProviders={uncoveredProviders} onSaved={refresh} />
        </>
      )}
    </>
  );
}

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
      <div className="method-tabs" role="tablist" aria-label="Bedrock auth method">
        <button type="button" role="tab" aria-selected={authMethod === "api_key"} className={`method-tab${authMethod === "api_key" ? " active" : ""}`} onClick={() => setAuthMethod("api_key")}>
          Bedrock API key
          <span className="method-tab-tag">Easiest</span>
        </button>
        <button type="button" role="tab" aria-selected={authMethod === "profile"} className={`method-tab${authMethod === "profile" ? " active" : ""}`} onClick={() => setAuthMethod("profile")}>
          AWS profile
        </button>
        <button type="button" role="tab" aria-selected={authMethod === "iam"} className={`method-tab${authMethod === "iam" ? " active" : ""}`} onClick={() => setAuthMethod("iam")}>
          IAM keys
        </button>
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

/** Settings > Models > ChatGPT subscription's detail page — no key form, a real OS browser
 * sign-in instead (POST kicks it off server-side, this polls status for the flip). Mirrors
 * OpenWorker's own `openai-codex` descriptor page: "Sign in" → "Signed in as {email}" with a
 * Sign out button, exactly what the reference screenshot shows. */
function CodexSignInFields({ onSaved }: { onSaved: () => void }) {
  const [status, setStatus] = useState<client.CodexAuthStatus | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setStatus(await client.codexAuthStatus());
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!status?.authorizing) return;
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, [status?.authorizing]);

  async function signIn() {
    setBusy(true);
    try {
      await client.beginCodexSignIn();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await client.codexSignOut();
      await refresh();
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  // Sign-in completed (authorizing flipped back off) — let the parent re-fetch the provider
  // list so its "● Ready" pill and the Models tab's card both pick up the new state.
  useEffect(() => {
    if (status && !status.authorizing && status.signedIn) onSaved();
  }, [status?.authorizing, status?.signedIn]);

  if (!status) return null;

  return (
    <div className="codex-signin-panel">
      {status.signedIn ? (
        <>
          <div className="codex-signedin-bar">
            <span>✓ Signed in as {status.account ?? "ChatGPT"}</span>
            <button className="btn-sm" disabled={busy} onClick={signOut}>
              Sign out
            </button>
          </div>
          <p className="codex-signin-note">Usage draws on the plan's rolling window, not per-token billing. Sign-in stays on this computer.</p>
        </>
      ) : status.authorizing ? (
        <>
          <div className="codex-signin-authorizing">
            <span className="codex-signin-spinner" />
            Waiting for sign-in in your browser…
          </div>
          {status.authorizeUrl && (
            <a className="codex-signin-note" href={status.authorizeUrl} target="_blank" rel="noreferrer" style={{ display: "block" }}>
              Sign-in tab didn't open? Click here.
            </a>
          )}
        </>
      ) : (
        <>
          {status.lastError && <div className="error-banner">{status.lastError}</div>}
          <button className="btn-primary accent" style={{ flex: "none" }} disabled={busy} onClick={signIn}>
            Sign in with ChatGPT
          </button>
        </>
      )}
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

      {provider.auth === "oauth" ? (
        <CodexSignInFields onSaved={onSaved} />
      ) : provider.noKeyNeeded ? (
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

const PROCEDURAL_KIND_LABEL: Record<client.ProceduralKind, string> = {
  tool: "Tool",
  command: "Command",
  domain: "Domain",
  readonly: "Read-only commands",
};

const PROCEDURAL_KIND_ICON = {
  tool: IconWrench,
  command: IconTerminal,
  domain: IconGlobe,
  readonly: IconEye,
} satisfies Record<client.ProceduralKind, () => ReturnType<typeof IconWrench>>;

const PROCEDURAL_PROMOTION_THRESHOLD = 3;

type MemorySubTab = "facts" | "sessions" | "rules";

function RuleDots({ observed, total }: { observed: number; total: number }) {
  return (
    <span className="rule-dots" aria-label={`observed in ${observed} of ${total} sessions`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={`rule-dot${i < observed ? " filled" : ""}`} />
      ))}
    </span>
  );
}

function MemoryTab({ workspace }: { workspace: string }) {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [episodes, setEpisodes] = useState<client.EpisodicItem[]>([]);
  const [rules, setRules] = useState<client.ProceduralRule[]>([]);
  const [memSettings, setMemSettings] = useState<client.MemorySettings | null>(null);
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<MemoryScope>("workspace");
  const [userRulesDraft, setUserRulesDraft] = useState("");
  const [editingRules, setEditingRules] = useState(false);
  const [busy, setBusy] = useState(false);
  const [subTab, setSubTab] = useState<MemorySubTab>("facts");

  function refresh() {
    client.listMemories().then((r) => setMemories(r.memories));
    if (workspace) {
      client.listEpisodicMemories(workspace).then((r) => setEpisodes(r.episodes));
      client.listProceduralRules(workspace).then((r) => setRules(r.rules));
    }
    client.getMemorySettings().then((s) => {
      setMemSettings(s);
      setUserRulesDraft(s.userRules);
    });
  }
  useEffect(refresh, [workspace]);

  async function add() {
    if (!content.trim()) return;
    await client.addMemory(content.trim(), scope, scope === "workspace" ? workspace : undefined);
    setContent("");
    refresh();
  }

  async function toggleEnabled() {
    if (!memSettings) return;
    setBusy(true);
    try {
      setMemSettings(await client.setMemorySettings({ enabled: !memSettings.enabled }));
    } finally {
      setBusy(false);
    }
  }

  async function saveUserRules() {
    setBusy(true);
    try {
      setMemSettings(await client.setMemorySettings({ userRules: userRulesDraft }));
      setEditingRules(false);
    } finally {
      setBusy(false);
    }
  }

  async function revokeRule(id: number) {
    await client.revokeProceduralRule(id);
    refresh();
  }

  const activeRuleCount = rules.filter((r) => r.promoted).length;

  return (
    <>
      <h2>Memory</h2>
      <p className="desc">What the agent remembers, across three tiers — and one place to turn any of it off.</p>

      {memSettings && (
        <div className="settings-card">
          <div className="settings-card-top">
            <div>
              <div className="settings-card-heading">
                <span className="settings-card-title">Memory</span>
                <span className={`provider-status ${memSettings.enabled ? "configured" : "unset"}`}>{memSettings.enabled ? "● On" : "Off"}</span>
              </div>
              <p className="desc settings-card-desc">
                Off disables saving new facts and session summaries, and stops injecting either into future chats. Existing memories are kept but inert.
              </p>
            </div>
            <button className={`switch${memSettings.enabled ? " on" : ""}`} disabled={busy} onClick={toggleEnabled} aria-label="Toggle memory" />
          </div>

          <div className="settings-section-label">Your rules</div>
          {editingRules ? (
            <>
              <textarea
                rows={3}
                placeholder="e.g. Always use tabs, not spaces. Never touch the dist/ folder."
                value={userRulesDraft}
                onChange={(e) => setUserRulesDraft(e.target.value)}
                autoFocus
              />
              <div className="field-row" style={{ justifyContent: "flex-start", marginTop: 8 }}>
                <button className="btn-sm" style={{ flex: "none" }} disabled={busy} onClick={saveUserRules}>
                  Save
                </button>
                <button
                  className="link-danger"
                  style={{ flex: "none" }}
                  onClick={() => {
                    setUserRulesDraft(memSettings.userRules);
                    setEditingRules(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : memSettings.userRules ? (
            <button type="button" className="memory-rules-preview" onClick={() => setEditingRules(true)}>
              <p>{memSettings.userRules}</p>
              <span className="memory-rules-edit">Edit</span>
            </button>
          ) : (
            <button className="btn-sm" style={{ flex: "none" }} onClick={() => setEditingRules(true)}>
              + Add your rules
            </button>
          )}
          <p className="desc" style={{ marginTop: 8, marginBottom: 0 }}>
            Written once, followed always — outranks anything the agent learned on its own.
          </p>
        </div>
      )}

      <div className="method-tabs" role="tablist" aria-label="Memory tier" style={{ marginTop: 26 }}>
        <button type="button" role="tab" aria-selected={subTab === "facts"} className={`method-tab${subTab === "facts" ? " active" : ""}`} onClick={() => setSubTab("facts")}>
          Facts <span className="method-tab-tag">{memories.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={subTab === "sessions"} className={`method-tab${subTab === "sessions" ? " active" : ""}`} onClick={() => setSubTab("sessions")}>
          Sessions <span className="method-tab-tag">{episodes.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={subTab === "rules"} className={`method-tab${subTab === "rules" ? " active" : ""}`} onClick={() => setSubTab("rules")}>
          Standing rules <span className="method-tab-tag">{activeRuleCount}</span>
        </button>
      </div>

      {subTab === "facts" && (
        <div className="memory-subpane">
          <p className="desc" style={{ marginBottom: 12 }}>
            Durable facts you or the agent saved explicitly — the same store its own <code>remember</code> tool writes to.
          </p>
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
        </div>
      )}

      {subTab === "sessions" && (
        <div className="memory-subpane">
          <p className="desc" style={{ marginBottom: 12 }}>
            Auto-written when a new session starts here — what happened, not something explicitly asked to be remembered.
          </p>
          {episodes.length === 0 && (
            <div className="empty-state">
              <h3>No session history yet</h3>
              <p>Once you've had more than one session in this workspace, a short summary of each past one shows up here.</p>
            </div>
          )}
          {episodes.map((e) => (
            <div className="list-card" key={e.id}>
              <div className="list-card-main">
                <div className="list-card-title">{e.summary}</div>
                <div className="list-card-sub">
                  {e.createdAt.slice(0, 10)} · {e.messageCount} messages
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {subTab === "rules" && (
        <div className="memory-subpane">
          <p className="desc" style={{ marginBottom: 12 }}>
            Permission habits noticed across repeated "always allow" clicks in this workspace — a rule only takes effect once it's shown up in {PROCEDURAL_PROMOTION_THRESHOLD} separate sessions.
          </p>
          {rules.length === 0 && (
            <div className="empty-state">
              <h3>No standing rules yet</h3>
              <p>Click "always allow" on the same tool, command, or domain across a few different sessions and it'll start forming here.</p>
            </div>
          )}
          {rules.map((r) => {
            const KindIcon = PROCEDURAL_KIND_ICON[r.kind];
            return (
              <div className="list-card" key={r.id}>
                <div className="list-card-main procedural-rule-main">
                  <span className={`procedural-rule-icon${r.promoted ? " active" : ""}`}>
                    <KindIcon />
                  </span>
                  <div>
                    <div className="list-card-title">
                      {PROCEDURAL_KIND_LABEL[r.kind]}
                      {r.value ? `: ${r.value}` : ""}
                    </div>
                    <div className="list-card-sub" style={{ fontFamily: "var(--font-body)" }}>
                      {r.promoted ? (
                        <span className="badge on">Active</span>
                      ) : (
                        <RuleDots observed={r.observedSessions} total={PROCEDURAL_PROMOTION_THRESHOLD} />
                      )}
                      {r.promoted && <span style={{ marginLeft: 8 }}>last used {r.lastUsedAt ? r.lastUsedAt.slice(0, 10) : "never"}</span>}
                    </div>
                  </div>
                </div>
                <div className="list-card-actions">
                  <button className="list-card-icon-btn danger" aria-label="Revoke rule" title="Revoke" onClick={() => revokeRule(r.id)}>
                    <IconTrash />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
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
