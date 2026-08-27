/**
 * Provider/model/auto-approve settings for the owned-engine backend — Electron's mirror of
 * apps/server/src/providers.ts. Same catalog, same SecretStore-backed layering (a key saved
 * here wins over the matching env var), same settings.json shape — deliberately kept
 * file-format-compatible even though the two processes never share a state dir, in case a
 * future host-agnostic settings module wants to read either one the same way.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { SecretStore } from "@metaharn/engine/src/trust/secretStore.js";

function stateDir(): string {
  return app.getPath("userData");
}

export interface ProviderCatalogEntry {
  name: string;
  displayName: string;
  noKeyNeeded: boolean;
  envVar?: string;
  defaultBaseUrl?: string;
}

// Kept identical to apps/server/src/providers.ts's catalog — see that file's comment on why
// every entry but "anthropic" is just OpenAIProvider pointed at a different baseURL.
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  { name: "anthropic", displayName: "Claude (Anthropic)", noKeyNeeded: false, envVar: "ANTHROPIC_API_KEY" },
  { name: "openai", displayName: "OpenAI", noKeyNeeded: false, envVar: "OPENAI_API_KEY" },
  { name: "ollama", displayName: "Ollama (local)", noKeyNeeded: true, defaultBaseUrl: "http://localhost:11434/v1" },
  { name: "openrouter", displayName: "OpenRouter", noKeyNeeded: false, envVar: "OPENROUTER_API_KEY", defaultBaseUrl: "https://openrouter.ai/api/v1" },
  { name: "together", displayName: "Together AI", noKeyNeeded: false, envVar: "TOGETHER_API_KEY", defaultBaseUrl: "https://api.together.xyz/v1" },
  { name: "fireworks", displayName: "Fireworks AI", noKeyNeeded: false, envVar: "FIREWORKS_API_KEY", defaultBaseUrl: "https://api.fireworks.ai/inference/v1" },
  { name: "deepseek", displayName: "DeepSeek", noKeyNeeded: false, envVar: "DEEPSEEK_API_KEY", defaultBaseUrl: "https://api.deepseek.com/v1" },
  { name: "groq", displayName: "Groq", noKeyNeeded: false, envVar: "GROQ_API_KEY", defaultBaseUrl: "https://api.groq.com/openai/v1" },
  { name: "mistral", displayName: "Mistral", noKeyNeeded: false, envVar: "MISTRAL_API_KEY", defaultBaseUrl: "https://api.mistral.ai/v1" },
  { name: "xai", displayName: "xAI (Grok)", noKeyNeeded: false, envVar: "XAI_API_KEY", defaultBaseUrl: "https://api.x.ai/v1" },
];

let store: SecretStore | undefined;
function secretStore(): SecretStore {
  if (!store) store = new SecretStore(join(stateDir(), "secrets.json"));
  return store;
}

function profileFor(name: string) {
  return secretStore().get(`provider:${name}`) as { apiKey?: string; baseUrl?: string } | undefined;
}

export interface ProviderStatus extends ProviderCatalogEntry {
  configured: boolean;
  baseUrl?: string;
}

export function listProviders(): ProviderStatus[] {
  return PROVIDER_CATALOG.map((entry) => {
    const profile = profileFor(entry.name);
    const hasKey = Boolean(profile?.apiKey) || Boolean(entry.envVar && process.env[entry.envVar]);
    return { ...entry, configured: entry.noKeyNeeded ? true : hasKey, baseUrl: profile?.baseUrl ?? entry.defaultBaseUrl };
  });
}

export function setProvider(name: string, input: { apiKey?: string; baseUrl?: string }): void {
  if (!PROVIDER_CATALOG.some((p) => p.name === name)) throw new Error(`unknown provider: ${name}`);
  const existing = profileFor(name) ?? {};
  secretStore().put(`provider:${name}`, {
    ...existing,
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
  });
}

export function deleteProvider(name: string): boolean {
  return secretStore().delete(name);
}

export function resolveProviderCredential(name: string): { apiKey?: string; baseUrl?: string } {
  const entry = PROVIDER_CATALOG.find((p) => p.name === name);
  const profile = profileFor(name);
  const apiKey = profile?.apiKey ?? (entry?.envVar ? process.env[entry.envVar] : undefined);
  const baseUrl = profile?.baseUrl ?? entry?.defaultBaseUrl;
  return { apiKey, baseUrl };
}

// -- default model + auto-approve --------------------------------------------------------

function settingsPath(): string {
  return join(stateDir(), "settings.json");
}

function readSettingsFile(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface DefaultModelSettings {
  provider: string;
  modelId: string;
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

export function getAutoApproveSetting(): boolean | undefined {
  const saved = readSettingsFile();
  return typeof saved.autoApprove === "boolean" ? saved.autoApprove : undefined;
}

export function setAutoApproveSetting(enabled: boolean): void {
  const merged = { ...readSettingsFile(), autoApprove: enabled };
  writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
}
