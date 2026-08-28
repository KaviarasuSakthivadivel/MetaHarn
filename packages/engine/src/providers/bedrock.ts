/**
 * AWS Bedrock provider — Claude models running inside the user's own AWS account.
 *
 * Scope: Claude-family models only, via Anthropic's own native Bedrock path
 * (`@anthropic-ai/bedrock-sdk`'s `AnthropicBedrock`, which speaks the identical Messages API
 * `AnthropicProvider` already converts to/from — see that module's converters, all reused
 * here unmodified by extending it and swapping only the underlying client). OpenWorker's own
 * Bedrock provider goes further and also reaches non-Claude models through Bedrock's generic
 * Converse API; that's deliberately not built here — Claude is this app's primary model
 * family everywhere else, and Converse is a materially different wire shape (its own
 * converters, its own capability matrix) not worth the added surface for this pass.
 *
 * Three auth methods, mirroring OpenWorker's Settings > Models > AWS Bedrock form exactly
 * (`coworker/providers/registry.py`'s `bedrock` descriptor):
 * - `apiKey` (a Bedrock API key / bearer token, generated on the Bedrock console — no AWS
 *   CLI or IAM setup needed): rides as `AnthropicBedrock`'s own `apiKey` option.
 * - `awsProfile` (a named profile from `~/.aws`): resolved via `@aws-sdk/credential-providers`'
 *   `fromIni`, injected through `providerChainResolver` rather than mutating the process's
 *   `AWS_PROFILE` env var — keeps a per-session profile choice from leaking into any other
 *   concurrent session's ambient credential resolution.
 * - `accessKeyId`/`secretAccessKey` (+ optional `sessionToken` for STS temporary credentials):
 *   passed straight through as `awsAccessKey`/`awsSecretKey`/`awsSessionToken`.
 *
 * All three fall through to `AnthropicBedrock`'s own default AWS credential provider chain
 * (env vars / `~/.aws` default profile / an EC2/ECS instance role) when none of the above are
 * supplied — same as leaving every field blank in OpenWorker's form.
 *
 * NOT live-verified against a real AWS account (none available in this environment) — the
 * `AnthropicBedrock` construction and the message converters it inherits from
 * `AnthropicProvider` are each independently well-founded (the SDK's own published types;
 * `AnthropicProvider`'s converters are already live-verified against the direct Anthropic
 * API), but the combination hasn't been exercised end to end. Flagged in
 * docs/architecture/08-known-limitations.md — verify against a real Bedrock-enabled account
 * before relying on this in production.
 */
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { fromIni } from "@aws-sdk/credential-providers";
import { AnthropicProvider } from "./anthropic.js";

export interface BedrockProviderOptions {
  region?: string;
  /** Bedrock API key / bearer token — the "Easiest" method in OpenWorker's own form. */
  apiKey?: string;
  /** A named profile from ~/.aws (blank → that chain's own default-profile resolution). */
  profile?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

// `AnthropicBedrock`'s constructor is overloaded on which combination of static AWS
// credential fields is present (both-or-neither, never one alone) so it can enforce that at
// the type level — a single spread-merged options object with independently-optional
// awsAccessKey/awsSecretKey satisfies none of those overloads. Building the options object
// per branch, each a literal matching exactly one overload, sidesteps that without a cast.
function buildClient(opts: BedrockProviderOptions): AnthropicBedrock {
  const base = {
    ...(opts.region ? { awsRegion: opts.region } : {}),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
  };
  if (opts.accessKeyId && opts.secretAccessKey) {
    return new AnthropicBedrock({ ...base, awsAccessKey: opts.accessKeyId, awsSecretKey: opts.secretAccessKey, awsSessionToken: opts.sessionToken ?? null });
  }
  // "AWS profile" method — only reached once IAM keys aren't both present above.
  if (opts.profile !== undefined && !opts.apiKey) {
    return new AnthropicBedrock({ ...base, providerChainResolver: () => Promise.resolve(fromIni({ profile: opts.profile || undefined })) });
  }
  // Bedrock API key (if set) or the default AWS credential provider chain.
  return new AnthropicBedrock({ ...base });
}

export class BedrockProvider extends AnthropicProvider {
  constructor(opts: BedrockProviderOptions = {}) {
    super(buildClient(opts));
  }
}
