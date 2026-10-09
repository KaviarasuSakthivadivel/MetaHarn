/**
 * Per-model list pricing, USD per token (published rates ÷ 1,000,000) — the one place this app
 * computes a real dollar cost from raw token counts, used by usage.ts's cross-session
 * aggregation (Weekly Rewind, Usage & Estimated Costs). Every OTHER cost-shaped field in this
 * codebase (TerminalSessionStats.cost, ownedEngine.ts's session stats) is hardcoded to 0 with an
 * explicit "no pricing table, 0 is honest" comment — this file IS that table, now that a feature
 * actually needs it. Same framing Xirp's own usage panel uses ("estimates based on public model
 * list prices"): a published list-price estimate, not a live billing figure — prompt caching
 * discounts, batch pricing, and any account-specific rate are not reflected.
 *
 * cacheWrite here is the 5-minute cache write rate (Anthropic's default; the 1-hour tier is
 * priced differently and isn't distinguishable from the transcript alone). Rates match the
 * published tier structure for the Claude Sonnet/Opus/Haiku families; "claude-sonnet-5" etc.
 * (see agents/claude.ts's MODEL_CONTEXT_WINDOWS) are this build's current model ids, billed at
 * their family's published tier.
 */
interface ModelRateUsd {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const PER_MILLION = 1_000_000;

function tier(input: number, output: number, cacheWrite: number, cacheRead: number): ModelRateUsd {
  return { input: input / PER_MILLION, output: output / PER_MILLION, cacheWrite: cacheWrite / PER_MILLION, cacheRead: cacheRead / PER_MILLION };
}

const OPUS_RATE = tier(15, 75, 18.75, 1.5);
const SONNET_RATE = tier(3, 15, 3.75, 0.3);
const HAIKU_RATE = tier(1, 5, 1.25, 0.1);

const MODEL_RATES: Record<string, ModelRateUsd> = {
  "claude-opus-5": OPUS_RATE,
  "claude-sonnet-5": SONNET_RATE,
  "claude-haiku-4-5": HAIKU_RATE,
};

/** Substring match on the model id (e.g. "claude-sonnet-5-20260101" → the "sonnet" tier) —
 * transcripts sometimes carry a dated/suffixed id rather than the bare one MODEL_RATES keys on. */
function rateFor(model: string): ModelRateUsd | null {
  if (MODEL_RATES[model]) return MODEL_RATES[model];
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return OPUS_RATE;
  if (lower.includes("sonnet")) return SONNET_RATE;
  if (lower.includes("haiku")) return HAIKU_RATE;
  return null;
}

/** Null (not 0) for a model this table has no rate for — usage.ts treats null as "exclude this
 * turn from cost totals" rather than silently under-counting as free. */
export function estimateCostUsd(
  model: string,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number | null {
  const rate = rateFor(model);
  if (!rate) return null;
  return tokens.input * rate.input + tokens.output * rate.output + tokens.cacheRead * rate.cacheRead + tokens.cacheWrite * rate.cacheWrite;
}
