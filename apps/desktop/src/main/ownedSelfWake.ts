/** Self-wake for the owned-engine backend — Electron's mirror of apps/server/src/selfWakeApi.ts.
 * See that file's module doc for why this stays free of any ownedEngine.ts/automation.ts
 * dependency (the resume logic lives in automation.ts instead, avoiding a circular import),
 * and for why only `sleep_until` is registered, not `wake_on`/`wake_on_event`. */
import { join } from "node:path";
import { app } from "electron";
import { WakeStore, createSelfWakeTools } from "@metaharn/engine/src/automation/selfwake.js";

let store: WakeStore | undefined;
export function wakeStore(): WakeStore {
  if (!store) store = new WakeStore(join(app.getPath("userData"), "selfwake.json"));
  return store;
}

export function selfWakeToolsFor(sessionId: string) {
  return createSelfWakeTools(wakeStore(), sessionId).filter((t) => t.name === "sleep_until");
}
