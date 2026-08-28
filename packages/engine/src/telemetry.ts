/**
 * Laminar (https://laminar.sh) tracing — auto-instruments the provider SDKs this package
 * already imports directly, so enabling it needs zero changes to providers/anthropic.ts,
 * openai.ts, or gemini.ts: Laminar monkey-patches the shared module's prototype at
 * `enableTelemetry()` time, and every subsequent call through that SDK (from any provider
 * built on it) gets traced automatically.
 *
 * Each SDK's `instrumentModules` value has its OWN required shape — verified directly against
 * the installed packages' compiled output, not assumed from the docs (they're inconsistent
 * with each other and, for Anthropic, inconsistent with Laminar's own top-level example):
 * - OpenAI: the default-exported class itself (`OpenAI.Chat.Completions` already lives on it
 *   as a static property).
 * - Anthropic: the whole module NAMESPACE, not the class — `@traceloop/instrumentation-anthropic`
 *   reads `module.Anthropic.Messages.prototype`, and the bare class has no `.Anthropic` property
 *   of its own to satisfy that.
 * - Gemini (`@google/genai`): either the `GoogleGenAI` class directly or a module namespace
 *   exposing it — both accepted.
 *
 * AWS Bedrock is NOT covered here, on purpose, not as an oversight: `@traceloop/instrumentation-
 * bedrock` patches `@aws-sdk/client-bedrock-runtime`'s own client class, but providers/bedrock.ts
 * uses `@anthropic-ai/bedrock-sdk`'s `AnthropicBedrock` — a different client that never touches
 * that AWS SDK class at all, so nothing Laminar ships would actually intercept its calls. Every
 * other provider in the catalog (every OpenAI-compatible vendor, Anthropic direct, Gemini) is
 * covered because they're all built on one of the three SDKs instrumented above.
 */
import { Laminar, observe } from "@lmnr-ai/lmnr";
import * as AnthropicModule from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

export interface TelemetryEndpoint {
  /** No port here — Laminar's own `baseUrl` option is host-only; ports are separate. */
  baseUrl?: string;
  httpPort?: number;
  grpcPort?: number;
}

export function isTelemetryActive(): boolean {
  return Laminar.initialized();
}

export function enableTelemetry(apiKey: string, endpoint: TelemetryEndpoint = {}): void {
  if (Laminar.initialized()) return;
  Laminar.initialize({
    projectApiKey: apiKey,
    baseUrl: endpoint.baseUrl,
    httpPort: endpoint.httpPort,
    grpcPort: endpoint.grpcPort,
    instrumentModules: { OpenAI, anthropic: AnthropicModule, google_genai: GoogleGenAI },
  });
}

/** Laminar's TS SDK supports a clean initialize → shutdown → initialize cycle (confirmed
 * against its own lifecycle docs), so toggling this off and back on later works without a
 * process restart — unlike its Python SDK, which can't re-initialize after shutdown. */
export async function disableTelemetry(): Promise<void> {
  if (!Laminar.initialized()) return;
  await Laminar.shutdown();
}

/** Groups everything that happens during one turn — every LLM call the engine makes (an
 * initial completion, then one more per tool-use round-trip) — under a single trace, tagged
 * with the chat session id. Without this, `instrumentModules`'s auto-instrumentation still
 * traces each individual LLM call correctly, but with no shared parent span to nest under:
 * OpenTelemetry has no way to know three sequential calls belong to the same turn, so each
 * becomes its own unrelated top-level trace — reproduced live (one prompt that triggered a
 * tool-use round-trip produced three separate trace ids instead of one). `sessionId` is
 * Laminar's own session-grouping field (`observe()`'s own docs: "associate trace with
 * session") — passing the engine's real session id means every turn in one chat groups under
 * one Laminar session too, not just one trace per turn.
 *
 * No-ops (just calls `fn()` directly) when telemetry isn't active, so callers don't need their
 * own isTelemetryActive() guard — `observe()` itself is documented to degrade to "call the
 * function unchanged" pre-initialize, but skipping the wrapper call entirely avoids relying on
 * that undocumented-for-TS behavior when tracing is simply off. */
export function traceTurn<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  if (!Laminar.initialized()) return fn();
  return observe({ name: "agent_turn", sessionId }, fn);
}
