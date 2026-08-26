/**
 * Interactive prompts over messaging — buttons instead of free-text replies.
 *
 * Ported from OpenWorker's coworker/interactions.py. When an Inbox item (inbox.ts) is mirrored
 * to a channel, discrete choices (approve/deny, an ask_user option) render as buttons. The
 * item id rides inside each button's value, so a click resolves the exact item directly via
 * InboxStore.resolve() — no reply-thread tracking. Free-text answers aren't offered over
 * messaging (the user opens the app for those).
 *
 * Provider-agnostic: a Button is {label, value}; each channel adapter renders it natively
 * (Slack Block Kit, Telegram inline keyboard, …). The value is opaque to the adapter —
 * encode()/decode() here own its meaning: (itemId, resolution).
 */
import { optionLabel } from "./inbox.js";
import type { InboxItem } from "./inbox.js";

export interface Button {
  label: string;
  /** Opaque to the adapter; encode()/decode() own its meaning. */
  value: string;
}

export function encode(itemId: string, resolution: string): string {
  return JSON.stringify({ id: itemId, r: resolution });
}

/** `[itemId, resolution]` from a button value, or null if it isn't ours (malformed JSON, or
 * valid JSON missing the `id` field). */
export function decode(value: string): [id: string, resolution: string] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (!obj.id) return null;
  const r = obj.r;
  return [String(obj.id), r === undefined || r === null ? "" : String(r)];
}

/** The discrete-choice buttons for an Inbox item, or [] if it has none (free-text question,
 * a grouped multi-question ask, a notification, …) — the caller then sends plain text with an
 * "open the app" hint instead. */
export function buttonsFor(item: InboxItem): Button[] {
  if (item.kind === "approval") {
    return [
      { label: "Approve", value: encode(item.id, "allow") },
      { label: "Deny", value: encode(item.id, "deny") },
    ];
  }
  if (item.kind === "question" && item.questions && item.questions.length > 0) {
    // Grouped questions (OpenWorker's OPE-51): one button row can't answer 2+ questions —
    // send plain text with the open-the-app hint instead.
    return [];
  }
  if (item.kind === "question" && item.options && item.options.length > 0) {
    // One button per option; the resolution IS the chosen option's label (what the agent
    // gets back). Rich {label, description, …} options button as their label.
    return item.options.map((opt) => {
      const label = optionLabel(opt);
      return { label, value: encode(item.id, label) };
    });
  }
  return [];
}
