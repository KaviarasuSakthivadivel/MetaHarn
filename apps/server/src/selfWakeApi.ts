/**
 * Self-wake — lets a session suspend itself (`sleep_until`) and resume automatically once its
 * wake time arrives, without burning context polling in a loop. Piggybacks on the SAME
 * Scheduler already running for automations (`automationApi.ts`'s `extraTick` seam) rather
 * than running a second timer loop — the actual resume logic lives in automationApi.ts, not
 * here, specifically to avoid a circular import (that file already imports session.ts's
 * createSession/findSessionPath; this one must not, since session.ts imports THIS file to
 * register the tool on every session).
 *
 * Only `sleep_until` is registered, not `wake_on`/`wake_on_event` (both exist in
 * @metaharn/engine's createSelfWakeTools) — those need something to call
 * `WakeStore.completeJob()`/`fireEvent()` from outside (a background-job runner, a webhook
 * receiver), and neither exists in this codebase. Registering a tool the agent could call but
 * that can never actually resolve would be worse than not offering it — see
 * docs/architecture/08-known-limitations.md.
 */
import { WakeStore, createSelfWakeTools } from "@metaharn/engine/src/automation/selfwake.js";
import { statePath } from "./state.js";

let store: WakeStore | undefined;
export function wakeStore(): WakeStore {
  if (!store) store = new WakeStore(statePath("selfwake.json"));
  return store;
}

/** `sleep_until` only — see module doc for why the other two aren't offered. */
export function selfWakeToolsFor(sessionId: string) {
  return createSelfWakeTools(wakeStore(), sessionId).filter((t) => t.name === "sleep_until");
}
