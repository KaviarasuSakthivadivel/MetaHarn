/**
 * The Inbox — a durable, cross-restart approval queue (@metaharn/engine's hitl/inbox.ts,
 * built into the package but never connected to either app before this pass — see
 * docs/architecture/08-known-limitations.md).
 *
 * One shared store for the whole process (like automationApi.ts's TaskStore), not one per
 * session — the entire point of an Inbox is that it outlives any one session's lifetime.
 * `inboxApprover(store, sessionId)` (the engine's own helper) is a drop-in `Approver`: it
 * writes a pending row instead of holding a bare in-memory resolver, so closing this process
 * with an approval still outstanding no longer means silently denying it — the row survives,
 * and the next resume() picks the exact same wait back up (addApproval() dedupes on
 * toolCallId, so a re-raised ask during resume never creates a duplicate item).
 */
import { InboxStore, inboxApprover } from "@metaharn/engine/src/hitl/inbox.js";
import { statePath } from "./state.js";

let store: InboxStore | undefined;
export function inboxStore(): InboxStore {
  if (!store) store = new InboxStore(statePath("inbox.db"));
  return store;
}

export { inboxApprover };

/** Maps this codebase's richer ApprovalOutcome (once/always_tool/always_command/
 * always_domain/readonly_session/deny) down to the 3-way resolution string
 * inboxApprover() understands. Lossy on purpose: neither current UI offers the finer-grained
 * outcomes yet (only "once"/"deny" are ever sent — grep confirms), so building out full
 * fidelity here would be speculative ahead of any consumer. */
export function toInboxResolution(outcome: ApprovalOutcomeLike): string {
  if (outcome === "always_tool") return "always";
  if (outcome === "once") return "allow";
  return "deny";
}

type ApprovalOutcomeLike = "once" | "always_tool" | "always_command" | "always_domain" | "readonly_session" | "deny";

/** Every still-open approval, across every session — what the Inbox view lists. */
export function listPendingInbox() {
  return inboxStore().pending();
}

/** Resolves a pending item by its OWN id, regardless of whether the session it belongs to is
 * currently loaded — unlike ServerSession.resolvePermission() (sessionId + toolCallId, only
 * meaningful for a live session's own resolvePermission handler), this is what a cross-session
 * Inbox view needs: the item id is already in hand from listPendingInbox(), and the whole point
 * of a durable Inbox is answering something without its session being open. The session picks
 * the resolution up on its own next resumePending() (or immediately, if it's live and waiting
 * in-process — InboxStore.resolve() fires that waiter directly). */
export function resolveInboxItem(itemId: string, outcome: ApprovalOutcomeLike): boolean {
  return inboxStore().resolve(itemId, toInboxResolution(outcome));
}
