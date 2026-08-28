/**
 * Subscription sign-in for the `openai-codex` provider (OAuth 2.0 + PKCE).
 *
 * Instead of an API key, the user signs in with their ChatGPT plan: a browser flow against
 * OpenAI's own auth service using the public subscription client id Codex CLI itself ships
 * (not a secret — it's baked into every copy of that tool), with the loopback redirect that id
 * is registered for (the port is FIXED; any other port fails the redirect-uri check
 * server-side). Ported from OpenWorker's `coworker/providers/codex_auth.py` — same endpoints,
 * same client id, same port, verified against that working implementation rather than
 * reconstructed from OpenAI's public docs (which don't document this flow at all; it's Codex
 * CLI's own mechanism, reverse-engineered and confirmed working by that reference).
 *
 * Tokens land in the SecretStore profile `provider:openai-codex` — the same
 * `provider:${name}` convention every other provider's saved credentials use (see
 * apps/server/src/providers.ts), so the existing profile-status plumbing picks this provider
 * up for free; it just checks `tokens` instead of `apiKey`.
 *
 * The pieces:
 *   - `signIn()`        — explicit-action only: bind the loopback port, open the browser, wait
 *     for the redirect, exchange the code, persist tokens + account id.
 *   - `CodexTokenStore`  — persistence + proactive refresh (JWT `exp`).
 *   - `verify()`         — the Test-button probe: one cheap authenticated request that
 *     distinguishes signed-out vs expired vs OK.
 *
 * The account id rides the token JWTs (the `https://api.openai.com/auth` claim); decoded
 * without verification — the backend verifies the token, this only routes with it.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import type { SecretStore } from "../trust/secretStore.js";

export const AUTH_ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_ISSUER}/oauth/authorize`;
const TOKEN_URL = `${AUTH_ISSUER}/oauth/token`;
// The public subscription client id (ships in Codex CLI itself — not a secret).
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
// Registered redirect for CLIENT_ID, verbatim — host and port are not ours to choose.
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPE = "openid profile email offline_access";
const ORIGINATOR = "metaharn";
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const PROFILE = "provider:openai-codex";
const FLOW_TIMEOUT_MS = 300_000;
// Refresh this close to the JWT `exp` instead of sending an about-to-die bearer.
const REFRESH_MARGIN_SECONDS = 300;
const ACCOUNT_CLAIM = "https://api.openai.com/auth";
// Smallest curated model — the verify probe should cost as close to nothing as possible.
const VERIFY_MODEL = "gpt-5.1-codex-mini";

export const SIGNED_OUT_ERROR =
  "Not signed in to ChatGPT — connect your account in Settings ▸ Models to use the subscription provider.";
export const EXPIRED_ERROR = "ChatGPT session expired — sign in again in Settings ▸ Models.";
export const PLAN_LIMIT_ERROR =
  "ChatGPT plan limit reached — your subscription's rolling usage window (about 5 hours) is used up. " +
  "Wait for it to reset, upgrade the plan, or switch to an API-key provider.";
const PORT_BUSY_ERROR = `Port ${CALLBACK_PORT} is already in use — the OpenAI Codex CLI is the usual holder. Quit it and start the sign-in again.`;

export class CodexAuthError extends Error {}
/** No usable tokens — the fix is an explicit sign-in, never a silent browser. */
export class CodexSignInRequiredError extends CodexAuthError {}

// -- PKCE / JWT helpers -----------------------------------------------------------------

function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const digest = createHash("sha256").update(verifier, "ascii").digest();
  return { verifier, challenge: digest.toString("base64url") };
}

function buildAuthorizeUrl(state: string, challenge: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // The simplified-flow switch the subscription client id expects, plus the client-name
    // tag the backend requires on every call.
    codex_cli_simplified_flow: "true",
    originator: ORIGINATOR,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Decode a JWT payload WITHOUT verification — only routing claims (`exp`, the account
 * object) are read; the backend is the one verifying signatures. Node's base64url decoding
 * handles the missing padding on its own, unlike most other runtimes. */
function jwtClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1] ?? "";
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function accountIdFrom(tokens: CodexTokens): string {
  for (const token of [tokens.idToken, tokens.accessToken]) {
    const auth = jwtClaims(token ?? "")[ACCOUNT_CLAIM];
    if (auth && typeof auth === "object") {
      const acct = (auth as Record<string, unknown>).chatgpt_account_id ?? (auth as Record<string, unknown>).account_id;
      if (typeof acct === "string" && acct) return acct;
    }
  }
  return "";
}

/** The non-auth headers every backend request must carry (auth is the bearer). */
export function backendHeaders(accountId: string, sessionId: string): Record<string, string> {
  return {
    "chatgpt-account-id": accountId,
    originator: ORIGINATOR,
    "OpenAI-Beta": "responses=experimental",
    "session-id": sessionId,
  };
}

// -- token persistence + refresh ---------------------------------------------------------

interface TokenResponseJson {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
}

interface CodexTokens {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
}

interface CodexProfile {
  tokens?: CodexTokens;
  tokensIssuedAt?: number;
  accountId?: string;
  accountEmail?: string;
}

async function tokenPost(data: Record<string, string>): Promise<Response> {
  return fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(data).toString(),
    signal: AbortSignal.timeout(30_000),
  });
}

async function exchangeCode(code: string, verifier: string): Promise<CodexTokens> {
  const resp = await tokenPost({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  if (resp.status >= 300) throw new CodexAuthError(`Sign-in failed — token exchange returned HTTP ${resp.status}.`);
  const json = (await resp.json()) as TokenResponseJson;
  return { accessToken: json.access_token, refreshToken: json.refresh_token, idToken: json.id_token };
}

/** Token set + account metadata in the `provider:openai-codex` SecretStore profile.
 *
 * `accessToken()` is what the provider calls per request: it hands back a live bearer,
 * refreshing proactively near the JWT `exp` and clearing the profile to a clean signed-out
 * state when the refresh token is rejected — never a crash loop. */
export class CodexTokenStore {
  constructor(private readonly secrets: SecretStore) {}

  private data(): CodexProfile {
    return (this.secrets.get(PROFILE) as CodexProfile | undefined) ?? {};
  }

  private merge(patch: Partial<CodexProfile>): void {
    this.secrets.put(PROFILE, { ...this.data(), ...patch } as Record<string, unknown>);
  }

  signedIn(): boolean {
    return Boolean(this.data().tokens);
  }

  accountLabel(): string | undefined {
    const data = this.data();
    return data.accountEmail || data.accountId || undefined;
  }

  /** Persist a token response, keeping prior values a refresh omitted (the refresh grant
   * often returns no new refresh/id token). */
  save(tokens: CodexTokens): void {
    const existing = this.data().tokens ?? {};
    const merged: CodexTokens = {
      accessToken: tokens.accessToken ?? existing.accessToken,
      refreshToken: tokens.refreshToken ?? existing.refreshToken,
      idToken: tokens.idToken ?? existing.idToken,
    };
    const patch: Partial<CodexProfile> = { tokens: merged, tokensIssuedAt: Math.floor(Date.now() / 1000) };
    const accountId = accountIdFrom(merged) || this.data().accountId;
    if (accountId) patch.accountId = accountId;
    const email = jwtClaims(merged.idToken ?? "").email;
    const resolvedEmail = typeof email === "string" && email ? email : this.data().accountEmail;
    if (resolvedEmail) patch.accountEmail = resolvedEmail;
    this.merge(patch);
  }

  clear(): boolean {
    return this.secrets.delete(PROFILE);
  }

  /** (live access token, account id) — refreshing first when stale/absent. */
  async accessToken(): Promise<{ token: string; accountId: string }> {
    const data = this.data();
    const access = data.tokens?.accessToken ?? "";
    if (!access && !data.tokens?.refreshToken) throw new CodexSignInRequiredError(SIGNED_OUT_ERROR);
    const exp = jwtClaims(access).exp;
    const stale = !access || (typeof exp === "number" && exp - Date.now() / 1000 < REFRESH_MARGIN_SECONDS);
    if (stale) return this.refresh();
    return { token: access, accountId: data.accountId ?? "" };
  }

  /** refresh_token grant → fresh (access token, account id). A rejected refresh token blanks
   * the profile — the provider reads as cleanly signed out. */
  async refresh(): Promise<{ token: string; accountId: string }> {
    const refreshToken = this.data().tokens?.refreshToken;
    if (!refreshToken) {
      this.clear();
      throw new CodexSignInRequiredError(EXPIRED_ERROR);
    }
    let resp: Response;
    try {
      resp = await tokenPost({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID });
    } catch (err) {
      throw new CodexAuthError(`Couldn't reach the sign-in service to refresh the ChatGPT session (${(err as Error).name}).`);
    }
    if (resp.status >= 400 && resp.status < 500) {
      this.clear();
      throw new CodexSignInRequiredError(EXPIRED_ERROR);
    }
    if (resp.status >= 300) throw new CodexAuthError(`ChatGPT session refresh failed (HTTP ${resp.status}) — try again.`);
    const json = (await resp.json()) as TokenResponseJson;
    this.save({ accessToken: json.access_token, refreshToken: json.refresh_token, idToken: json.id_token });
    const data = this.data();
    return { token: data.tokens?.accessToken ?? "", accountId: data.accountId ?? "" };
  }
}

// -- interactive sign-in flow -------------------------------------------------------------

/** The last authorize URL, surfaced over REST so the GUI can offer "reopen sign-in page" if
 * the popup was lost. */
export let lastAuthorizeUrl: string | undefined;
let activeServer: Server | undefined;

function htmlResponse(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>MetaHarn</title>
<body style="font-family: system-ui; margin: 4rem auto; max-width: 28rem; text-align: center;">
<h2>${title}</h2><p>${body}</p></body>`;
}

function startCallbackServer(expectedState: string): Promise<{ server: Server; code: Promise<string> }> {
  return new Promise((resolveStart, rejectStart) => {
    let resolveCode: (code: string) => void;
    let rejectCode: (err: Error) => void;
    const code = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    let settled = false;

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" }).end(htmlResponse("Not found", ""));
        return;
      }
      const error = url.searchParams.get("error");
      const authCode = url.searchParams.get("code");
      const state = url.searchParams.get("state") ?? "";
      if (error) {
        res
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(htmlResponse("Sign-in failed", "The service reported an error. Return to MetaHarn and try again."));
        if (!settled) {
          settled = true;
          rejectCode(new CodexAuthError(`Sign-in failed — the service returned: ${error}`));
        }
        return;
      }
      // Same loopback gate every OAuth callback needs: a stray local hit with the wrong state
      // must not consume the flow — only the genuine redirect resolves it.
      const stateBuf = Buffer.from(state);
      const expectedBuf = Buffer.from(expectedState);
      const stateMatches = stateBuf.length === expectedBuf.length && timingSafeEqual(stateBuf, expectedBuf);
      if (!authCode || !stateMatches) {
        res
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(htmlResponse("Nothing waiting for this sign-in", "The sign-in may have timed out. Return to MetaHarn and start it again."));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(htmlResponse("Signed in", "You can close this tab and return to MetaHarn."));
      if (!settled) {
        settled = true;
        resolveCode(authCode);
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") rejectStart(new CodexAuthError(PORT_BUSY_ERROR));
      else rejectStart(err);
    });
    server.listen(CALLBACK_PORT, "127.0.0.1", () => resolveStart({ server, code }));
  });
}

/** Best-effort cross-platform "open the user's browser" — a failed spawn is silently
 * swallowed; `lastAuthorizeUrl` stays available for the caller to surface as a manual link. */
function openBrowserBestEffort(url: string): void {
  try {
    const child =
      process.platform === "darwin"
        ? spawn("open", [url], { stdio: "ignore", detached: true })
        : process.platform === "win32"
          ? spawn("cmd", ["/c", "start", '""', url], { stdio: "ignore", detached: true, windowsHide: true })
          : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // best-effort — the GUI still has lastAuthorizeUrl to offer as a manual link
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface SignInOptions {
  timeoutMs?: number;
  /** Set false in tests / non-interactive contexts to skip the actual browser launch. */
  openBrowser?: boolean;
}

export interface SignInResult {
  ok: true;
  account?: string;
}

/** Run the full interactive flow: loopback server → browser → code → tokens.
 *
 * Explicit-action only (a Settings button) — never called from an engine turn. */
export async function signIn(secrets: SecretStore, opts: SignInOptions = {}): Promise<SignInResult> {
  const timeoutMs = opts.timeoutMs ?? FLOW_TIMEOUT_MS;
  if (activeServer) {
    // A stale flow lost its browser tab; the new one takes the port.
    activeServer.close();
    activeServer = undefined;
  }
  const { verifier, challenge } = createPkce();
  const state = randomBytes(18).toString("base64url");
  const url = buildAuthorizeUrl(state, challenge);
  lastAuthorizeUrl = url;
  const { server, code: codePromise } = await startCallbackServer(state);
  activeServer = server;
  try {
    if (opts.openBrowser !== false) openBrowserBestEffort(url);
    const code = await withTimeout(
      codePromise,
      timeoutMs,
      () => new CodexAuthError(`Sign-in timed out — the browser window was not completed in ${Math.floor(timeoutMs / 60_000)} minutes.`),
    );
    const tokens = await exchangeCode(code, verifier);
    const store = new CodexTokenStore(secrets);
    store.save(tokens);
    if (!store.signedIn()) {
      store.clear();
      throw new CodexAuthError("Sign-in failed — the token response had no access token.");
    }
    return { ok: true, account: store.accountLabel() };
  } finally {
    server.close();
    if (activeServer === server) activeServer = undefined;
  }
}

// -- verify probe ---------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean;
  account?: string;
  error?: string;
  state?: "signed_out" | "expired";
  note?: string;
}

/** Test-button probe: one cheap authenticated request against the backend. Distinguishes
 * signed-out (no/rejected tokens) vs expired (401 with a bearer we thought was live) vs OK.
 * Never throws; same {ok, error?, state?} shape as every other provider's verify path. */
export async function verify(secrets: SecretStore, timeoutMs = 10_000): Promise<VerifyResult> {
  const store = new CodexTokenStore(secrets);
  if (!store.signedIn()) return { ok: false, error: SIGNED_OUT_ERROR, state: "signed_out" };
  let token: string;
  let accountId: string;
  try {
    ({ token, accountId } = await store.accessToken());
  } catch (err) {
    if (err instanceof CodexSignInRequiredError) return { ok: false, error: err.message, state: "signed_out" };
    return { ok: false, error: (err as Error).message };
  }
  try {
    const resp = await fetch(`${CODEX_BASE_URL}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...backendHeaders(accountId, randomUUID()) },
      body: JSON.stringify({ model: VERIFY_MODEL, input: "Reply with OK.", store: false, stream: true, max_output_tokens: 16 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Only the status matters here — cancel rather than drain the stream body.
    await resp.body?.cancel().catch(() => {});
    if (resp.status < 300) return { ok: true, account: store.accountLabel() };
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: EXPIRED_ERROR, state: "expired" };
    if (resp.status === 429) return { ok: true, account: store.accountLabel(), note: PLAN_LIMIT_ERROR };
    return { ok: false, error: `The ChatGPT backend returned HTTP ${resp.status}.` };
  } catch (err) {
    return { ok: false, error: `Couldn't reach the ChatGPT backend (${(err as Error).name}).` };
  }
}
