/** The Inbox for the owned-engine backend — Electron's mirror of apps/server/src/inboxApi.ts.
 * See that file's module doc for the design (durable, cross-restart approval queue). */
import { join } from "node:path";
import { app } from "electron";
import { InboxStore, inboxApprover } from "@metaharn/engine/src/hitl/inbox.js";

let store: InboxStore | undefined;
export function inboxStore(): InboxStore {
  if (!store) store = new InboxStore(join(app.getPath("userData"), "inbox.db"));
  return store;
}

export { inboxApprover };

type ApprovalOutcomeLike = "once" | "always_tool" | "always_command" | "always_domain" | "readonly_session" | "deny";

/** See apps/server/src/inboxApi.ts's identical function for why this mapping is lossy on
 * purpose — neither UI offers the finer-grained outcomes yet. */
export function toInboxResolution(outcome: ApprovalOutcomeLike): string {
  if (outcome === "always_tool") return "always";
  if (outcome === "once") return "allow";
  return "deny";
}

export function listPendingInbox() {
  return inboxStore().pending();
}

/** See apps/server/src/inboxApi.ts's identical resolveInboxItem() — resolves a pending item by
 * its own id regardless of whether the owning session is currently loaded in any window. */
export function resolveInboxItem(itemId: string, outcome: ApprovalOutcomeLike): boolean {
  return inboxStore().resolve(itemId, toInboxResolution(outcome));
}
