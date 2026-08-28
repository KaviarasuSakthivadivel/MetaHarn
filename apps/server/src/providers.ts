/**
 * Provider/model settings for the server surface — API keys (via @metaharn/engine's
 * SecretStore) and the default provider:model pair, both editable from the web UI's
 * Settings > Models page instead of only through .env.
 *
 * A key entered here takes priority over the matching env var (ANTHROPIC_API_KEY etc.) at
 * read time, so existing .env-based setups keep working untouched until someone actually
 * uses the UI to override them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SecretStore } from "@metaharn/engine/src/trust/secretStore.js";
import { statePath } from "./state.js";

export interface ProviderCatalogEntry {
  name: string;
  displayName: string;
  /** True for providers with no API key of their own (a local server like Ollama). */
  noKeyNeeded: boolean;
  /** Env var this provider falls back to when no key is saved via the UI. */
  envVar?: string;
  defaultBaseUrl?: string;
  /** Dispatch hint for session.ts's buildProviderClient(). Omitted → "openai-compat" (the
   * OpenAIProvider(apiKey, {baseURL}) path every vendor below defaults to); "anthropic" is
   * handled by its own `name === "anthropic"` check rather than this field, unchanged from
   * before this catalog grew a `kind`. */
  kind?: "gemini" | "bedrock";
}

// Every entry except "anthropic"/"gemini"/"bedrock" speaks the OpenAI Chat Completions wire
// shape — see session.ts's buildProviderClient(), which routes all of them through the same
// OpenAIProvider(apiKey, {baseURL}) constructor Ollama already proved out. Base URLs are each
// vendor's own documented OpenAI-compatible endpoint (not guessed): DeepSeek, Groq, Mistral,
// Fireworks, Together, OpenRouter, xAI, Z AI, Moonshot (Kimi), MiniMax, Alibaba (Qwen), and
// Meta all publish one specifically for drop-in use with the OpenAI SDK — matching the vendor
// list and endpoints in OpenWorker's own `coworker/providers/registry.py`. Untested against a
// real account in this environment (no keys on hand for most of these) — the mechanism itself
// is proven (Ollama), the base URLs are not live-verified here.
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  { name: "anthropic", displayName: "Claude (Anthropic)", noKeyNeeded: false, envVar: "ANTHROPIC_API_KEY" },
  { name: "openai", displayName: "OpenAI", noKeyNeeded: false, envVar: "OPENAI_API_KEY" },
  { name: "gemini", displayName: "Gemini (Google)", noKeyNeeded: false, envVar: "GEMINI_API_KEY", kind: "gemini" },
  { name: "bedrock", displayName: "AWS Bedrock", noKeyNeeded: false, kind: "bedrock" },
  { name: "ollama", displayName: "Ollama (local)", noKeyNeeded: true, defaultBaseUrl: "http://localhost:11434/v1" },
  { name: "openrouter", displayName: "OpenRouter", noKeyNeeded: false, envVar: "OPENROUTER_API_KEY", defaultBaseUrl: "https://openrouter.ai/api/v1" },
  { name: "together", displayName: "Together AI", noKeyNeeded: false, envVar: "TOGETHER_API_KEY", defaultBaseUrl: "https://api.together.xyz/v1" },
  { name: "fireworks", displayName: "Fireworks AI", noKeyNeeded: false, envVar: "FIREWORKS_API_KEY", defaultBaseUrl: "https://api.fireworks.ai/inference/v1" },
  { name: "deepseek", displayName: "DeepSeek", noKeyNeeded: false, envVar: "DEEPSEEK_API_KEY", defaultBaseUrl: "https://api.deepseek.com/v1" },
  { name: "groq", displayName: "Groq", noKeyNeeded: false, envVar: "GROQ_API_KEY", defaultBaseUrl: "https://api.groq.com/openai/v1" },
  { name: "mistral", displayName: "Mistral", noKeyNeeded: false, envVar: "MISTRAL_API_KEY", defaultBaseUrl: "https://api.mistral.ai/v1" },
  { name: "xai", displayName: "xAI (Grok)", noKeyNeeded: false, envVar: "XAI_API_KEY", defaultBaseUrl: "https://api.x.ai/v1" },
  { name: "zai", displayName: "Z AI (GLM)", noKeyNeeded: false, envVar: "ZAI_API_KEY", defaultBaseUrl: "https://api.z.ai/api/paas/v4" },
  { name: "kimi", displayName: "Kimi (Moonshot AI)", noKeyNeeded: false, envVar: "MOONSHOT_API_KEY", defaultBaseUrl: "https://api.moonshot.ai/v1" },
  { name: "minimax", displayName: "MiniMax", noKeyNeeded: false, envVar: "MINIMAX_API_KEY", defaultBaseUrl: "https://api.minimax.io/v1" },
  { name: "qwen", displayName: "Qwen (Alibaba)", noKeyNeeded: false, envVar: "DASHSCOPE_API_KEY", defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
  { name: "meta", displayName: "Meta (Muse Spark)", noKeyNeeded: false, envVar: "META_API_KEY", defaultBaseUrl: "https://api.meta.ai/v1" },
];

let store: SecretStore | undefined;
function secretStore(): SecretStore {
  if (!store) store = new SecretStore(statePath("secrets.json"));
  return store;
}

/** A provider's saved fields — {apiKey, baseUrl} for the openai-compat majority, or the
 * region/authMethod/… bag AWS Bedrock's multi-method form needs. SecretStore itself is
 * schemaless (plain JSON), so this is a type-level widening only. */
type ProviderProfile = Record<string, string | undefined>;

function profileFor(name: string): ProviderProfile | undefined {
  return secretStore().get(`provider:${name}`) as ProviderProfile | undefined;
}

export interface ProviderStatus extends ProviderCatalogEntry {
  configured: boolean;
  baseUrl?: string;
}

/** Bedrock has no single "key" field — "configured" means whichever of its three auth
 * methods is actually selected has the field(s) it needs (ambient credentials for the
 * "profile" method are, by design, unverifiable without a live AWS call, so a blank profile
 * name still counts as configured — same leniency OpenWorker's own descriptor_configured()
 * gives it). */
function bedrockConfigured(profile: ProviderProfile | undefined): boolean {
  const method = profile?.authMethod || "api_key";
  if (method === "iam") return Boolean(profile?.awsAccessKeyId && profile?.awsSecretAccessKey);
  if (method === "profile") return true;
  return Boolean(profile?.bedrockApiKey);
}

export function listProviders(): ProviderStatus[] {
  return PROVIDER_CATALOG.map((entry) => {
    const profile = profileFor(entry.name);
    const hasKey =
      entry.kind === "bedrock"
        ? bedrockConfigured(profile)
        : Boolean(profile?.apiKey) || Boolean(entry.envVar && process.env[entry.envVar]);
    return {
      ...entry,
      configured: entry.noKeyNeeded ? true : hasKey,
      baseUrl: profile?.baseUrl ?? entry.defaultBaseUrl,
    };
  });
}

export function setProvider(name: string, input: ProviderProfile): void {
  if (!PROVIDER_CATALOG.some((p) => p.name === name)) throw new Error(`unknown provider: ${name}`);
  const existing = profileFor(name) ?? {};
  const merged: ProviderProfile = { ...existing };
  for (const [key, value] of Object.entries(input)) if (value !== undefined) merged[key] = value;
  secretStore().put(`provider:${name}`, merged);
}

export function deleteProvider(name: string): boolean {
  return secretStore().delete(`provider:${name}`);
}

/** Resolved credential for building a live ProviderClient — saved key first, then the
 * matching env var, then (for a no-key provider like Ollama) just the base URL. */
export function resolveProviderCredential(name: string): { apiKey?: string; baseUrl?: string } {
  const entry = PROVIDER_CATALOG.find((p) => p.name === name);
  const profile = profileFor(name);
  const apiKey = profile?.apiKey ?? (entry?.envVar ? process.env[entry.envVar] : undefined);
  const baseUrl = profile?.baseUrl ?? entry?.defaultBaseUrl;
  return { apiKey, baseUrl };
}

export interface BedrockCredential {
  region?: string;
  authMethod?: string;
  bedrockApiKey?: string;
  awsProfile?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
}

/** Bedrock's saved fields, resolved straight from its profile — no env-var fallback (unlike
 * the single-key providers above), matching OpenWorker's own three-method form exactly.
 * `authMethod` defaults to "api_key" ("Easiest" in that form) when unset. */
export function resolveBedrockCredential(): BedrockCredential {
  const profile = profileFor("bedrock") ?? {};
  return {
    region: profile.region,
    authMethod: profile.authMethod || "api_key",
    bedrockApiKey: profile.bedrockApiKey,
    awsProfile: profile.awsProfile,
    awsAccessKeyId: profile.awsAccessKeyId,
    awsSecretAccessKey: profile.awsSecretAccessKey,
    awsSessionToken: profile.awsSessionToken,
  };
}

// -- default model --------------------------------------------------------------------------

interface DefaultModelSettings {
  provider: string;
  modelId: string;
}

function settingsPath(): string {
  return statePath("settings.json");
}

function readSettingsFile(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function getDefaultModel(): DefaultModelSettings {
  const saved = readSettingsFile();
  if (typeof saved.defaultProvider === "string" && typeof saved.defaultModelId === "string") {
    return { provider: saved.defaultProvider, modelId: saved.defaultModelId };
  }
  return {
    provider: process.env.METAHARN_MODEL_PROVIDER ?? "anthropic",
    modelId: process.env.METAHARN_MODEL_ID ?? "claude-opus-4-5",
  };
}

export function setDefaultModel(provider: string, modelId: string): void {
  const merged = { ...readSettingsFile(), defaultProvider: provider, defaultModelId: modelId };
  writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
}

// -- auto-approve --------------------------------------------------------------------------

/** UI-set value takes priority; `undefined` means "not set here," so the caller falls back to
 * `METAHARN_AUTO_APPROVE` — same layering as the provider keys above. */
export function getAutoApprove(): boolean | undefined {
  const saved = readSettingsFile();
  return typeof saved.autoApprove === "boolean" ? saved.autoApprove : undefined;
}

export function setAutoApprove(enabled: boolean): void {
  const merged = { ...readSettingsFile(), autoApprove: enabled };
  writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
}

// -- web search (the Access panel's "Sources: Browser" toggle) -----------------------------

/** Whether new sessions register `web_search` (keyless DuckDuckGo by default — see
 * tools/websearch.ts). Defaults on: it's low-risk, auto-approved, no key required to start
 * working, and OpenWorker's own reference UI shows this source on by default too. */
export function getWebSearchEnabled(): boolean {
  const saved = readSettingsFile();
  return typeof saved.webSearchEnabled === "boolean" ? saved.webSearchEnabled : true;
}

export function setWebSearchEnabled(enabled: boolean): void {
  const merged = { ...readSettingsFile(), webSearchEnabled: enabled };
  writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
}
