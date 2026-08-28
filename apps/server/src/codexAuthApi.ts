/**
 * ChatGPT-subscription sign-in — thin server-side wrapper around @metaharn/engine's
 * codexAuth.ts, exposing the interactive OAuth flow over REST. The flow itself takes as long
 * as the user takes in the browser, so `runCodexSignIn()` runs as a fire-and-forget background
 * task from index.ts's route handler; the GUI polls `codexStatus()` for the flip from
 * "authorizing" to signed-in (or a surfaced error) — same shape OpenWorker's own
 * `begin_codex_signin`/`codex_signin`/`codex_status`/`codex_signout` use for the identical
 * feature.
 */
import { CodexTokenStore, lastAuthorizeUrl, signIn } from "@metaharn/engine/src/providers/codexAuth.js";
import { providerSecretStore } from "./providers.js";

let authorizing = false;
let lastError: string | undefined;

/** Flip `authorizing` BEFORE the background sign-in task starts, so the GUI's first poll
 * after the button press already shows it. */
export function beginCodexSignIn(): void {
  authorizing = true;
  lastError = undefined;
}

/** Runs the interactive browser sign-in and stores the tokens. Callers fire this in the
 * background (`void runCodexSignIn()`) and poll `codexStatus()` for the result. */
export async function runCodexSignIn(): Promise<{ ok: boolean; account?: string; error?: string }> {
  authorizing = true;
  lastError = undefined;
  try {
    return await signIn(providerSecretStore());
  } catch (err) {
    lastError = (err as Error).message;
    return { ok: false, error: lastError };
  } finally {
    authorizing = false;
  }
}

export interface CodexStatus {
  signedIn: boolean;
  account?: string;
  authorizing: boolean;
  lastError?: string;
  authorizeUrl?: string;
}

export function codexStatus(): CodexStatus {
  const store = new CodexTokenStore(providerSecretStore());
  return { signedIn: store.signedIn(), account: store.accountLabel(), authorizing, lastError, authorizeUrl: lastAuthorizeUrl };
}

export function codexSignOut(): { ok: true; hadTokens: boolean } {
  const hadTokens = new CodexTokenStore(providerSecretStore()).clear();
  lastError = undefined;
  return { ok: true, hadTokens };
}
