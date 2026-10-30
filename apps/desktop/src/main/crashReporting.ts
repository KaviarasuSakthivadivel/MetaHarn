import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/**
 * Crash reporting (JS exceptions + native minidumps, via @sentry/electron) is gated behind TWO
 * independent switches, both default-OFF:
 *
 *   1. SENTRY_DSN (an env var, read via dotenv/config like the rest of this app's config) — set
 *      only by whoever BUILDS a release. Nothing is ever sent anywhere for anyone building from
 *      source without their own DSN; there is no hardcoded project DSN in this repo.
 *   2. The user's own toggle (below), persisted locally and OFF until they explicitly turn it on
 *      in Settings → About → Privacy — so even a published build with a real DSN baked in sends
 *      nothing until the person running it opts in themselves.
 *
 * Both gates exist because they answer different questions: #1 is "does this build have
 * somewhere to send reports at all" (a maintainer/build-time decision), #2 is "did the actual
 * person running this copy agree to send them" (a per-user, per-install consent decision) — a
 * DSN being present doesn't imply consent, and consent without a DSN has nothing to send to.
 */

function isConfigured(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}

interface CrashReportingPrefs {
  enabled: boolean;
}

function prefsPath(): string {
  return join(app.getPath("userData"), "crashReporting.json");
}

function readPrefs(): CrashReportingPrefs {
  try {
    const raw = readFileSync(prefsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return { enabled: parsed.enabled === true };
  } catch {
    // No file yet (first run), or it's corrupt — either way, the safe default is off, not on.
    return { enabled: false };
  }
}

function writePrefs(prefs: CrashReportingPrefs): void {
  writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2) + "\n");
}

function isEnabled(): boolean {
  return readPrefs().enabled;
}

/**
 * Called once, as early as possible in main.ts — before app.setName, before any window is
 * created — so a crash during startup itself still has a chance to be captured. Calling
 * app.getPath here (inside readPrefs, via prefsPath) works before app is "ready" on every
 * platform this app packages for (macOS/Windows; confirmed against Electron's own docs — only a
 * handful of sandboxed/custom userData-path edge cases need app.whenReady() first, none of which
 * apply here). A no-op (no import of @sentry/electron is even evaluated beyond the static import
 * below, and Sentry.init is simply never called) whenever either gate above is closed.
 */
export async function initCrashReporting(): Promise<void> {
  if (!isConfigured() || !isEnabled()) return;
  const Sentry = await import("@sentry/electron/main");
  Sentry.init({ dsn: process.env.SENTRY_DSN });
}

/** Exposed to the renderer (Settings → About → Privacy) via IPC — see ipc.ts. */
export function getCrashReportingStatus(): { configured: boolean; enabled: boolean } {
  return { configured: isConfigured(), enabled: isEnabled() };
}

/**
 * Takes effect on the NEXT app launch, not live — Sentry.init() isn't meant to be torn down and
 * re-run mid-session (its docs don't offer a supported "disable" call beyond Sentry.close(),
 * which stops the client but can't un-wrap the global-error-handler hooks init() already
 * installed), and restart-to-apply is a normal, well-understood pattern for a setting like this.
 * The Settings UI says so explicitly rather than implying an immediate effect it can't deliver.
 */
export function setCrashReportingEnabled(enabled: boolean): void {
  writePrefs({ enabled });
}
