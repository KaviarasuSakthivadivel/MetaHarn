/**
 * Shared provider presentation data — vendor icons, curated model lists, and short
 * descriptions. Used by Settings.tsx (the Models tab's provider detail pages) AND the
 * composer's model picker (App.tsx) — factored out here so both draw from exactly one catalog
 * instead of two copies drifting apart.
 */
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
// Not kimi-color.svg: its "K" mark is fill="#fff" with no covering backdrop shape behind it
// (unlike Gemini/Bedrock/Meta's -color variants, which are self-contained) — on this app's
// white .provider-icon background it renders as an invisible white-on-white mark. The plain
// kimi.svg uses fill="currentColor" throughout, same pattern already used for OpenAI/Ollama/
// Groq above, and inherits --ink correctly.
import kimiSvg from "@lobehub/icons-static-svg/icons/kimi.svg?raw";
import minimaxColorSvg from "@lobehub/icons-static-svg/icons/minimax-color.svg?raw";
import qwenColorSvg from "@lobehub/icons-static-svg/icons/qwen-color.svg?raw";
import metaColorSvg from "@lobehub/icons-static-svg/icons/meta-color.svg?raw";

const PROVIDER_ICON_SVG: Record<string, string> = {
  anthropic: claudeColorSvg,
  openai: openaiSvg,
  "openai-codex": openaiSvg,
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
  kimi: kimiSvg,
  minimax: minimaxColorSvg,
  qwen: qwenColorSvg,
  meta: metaColorSvg,
};

/** Renders a vendor's real SVG mark from PROVIDER_ICON_SVG — build-time trusted content (an
 * installed npm package, never user input), so innerHTML here carries no XSS risk. */
export function ProviderIcon({ name }: { name: string }) {
  const svg = PROVIDER_ICON_SVG[name];
  if (!svg) return <span style={{ fontWeight: 800, fontSize: 13 }}>{name.slice(0, 2).toUpperCase()}</span>;
  return <span className="provider-icon-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export interface CuratedModel {
  id: string;
  label: string;
}

/** Curated, agent-capable models per provider — what a provider's detail page lists under
 * "Included models," and what the composer's model picker offers for a configured provider.
 * Every id here is a real identifier that provider's API accepts today; kept short per provider
 * on purpose (2-4 entries) rather than mirroring a vendor's entire catalog, since this is
 * "models actually worth running an agent on," not an exhaustive model directory. */
export const PROVIDER_MODELS: Record<string, CuratedModel[]> = {
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
  // ChatGPT-subscription catalog — curated to the ids the subscription backend actually
  // serves (5.6 tiers: Sol flagship / Terra balanced / Luna fast), same list OpenWorker's own
  // `coworker/providers/matrix.py` maintains for this identical OAuth provider.
  "openai-codex": [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
    { id: "gpt-5.2", label: "GPT-5.2" },
    { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
    { id: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
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

export const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  anthropic: "Claude's own API — the model family this app is built around.",
  openai: "GPT and o-series models via OpenAI's own API.",
  "openai-codex": "Sign in with your ChatGPT plan and run OpenAI models through your subscription — no API key. Tokens stay on this machine.",
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
