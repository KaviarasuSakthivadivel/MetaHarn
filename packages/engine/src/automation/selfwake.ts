/**
 * Self-wake — lets a long-running agent session suspend and be re-invoked on a trigger,
 * turning an always-on agent into suspend/resume (event-driven, ~zero idle cost).
 *
 * Three triggers: a **timer** (`sleep_until`), **on-completion** of a backgrounded job
 * (`wake_on`), and **on-event** (`wake_on_event`, e.g. a connector/webhook signal). This
 * module owns the wake records + the due/complete/fire logic only — it never touches Engine.
 * The scheduler tick (scheduler.ts's `extraTick` seam) is expected to consume `due()` /
 * `completeJob()` / `fireEvent()` and actually resume the matching session; wiring that up is
 * the host's job, not this module's.
 *
 * Ported from OpenWorker's selfwake.py. JSON-file-backed like the Python (a `WakeStore` with
 * no `filePath` stays purely in-memory, same as Python's `path=None`).
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition, ToolSchema } from "../types.js";

export const WAKE_KIND_TIMER = "timer";
export const WAKE_KIND_COMPLETION = "completion";
export const WAKE_KIND_EVENT = "event";
export type WakeKind = typeof WAKE_KIND_TIMER | typeof WAKE_KIND_COMPLETION | typeof WAKE_KIND_EVENT;

export const WAKE_STATE_PENDING = "pending";
export const WAKE_STATE_DUE = "due";
export const WAKE_STATE_FIRED = "fired";
export type WakeState = typeof WAKE_STATE_PENDING | typeof WAKE_STATE_DUE | typeof WAKE_STATE_FIRED;

export interface Wake {
  id: string;
  sessionId: string;
  kind: WakeKind;
  state: WakeState;
  /** ISO, for timer wakes. */
  fireAt: string | null;
  /** For completion wakes. */
  jobId: string | null;
  /** For on-event wakes. */
  eventKey: string | null;
  note: string;
  createdAt: string;
}

function makeWake(partial: Omit<Wake, "id" | "state" | "createdAt">): Wake {
  return { id: randomUUID(), state: WAKE_STATE_PENDING, createdAt: new Date().toISOString(), ...partial };
}

export class WakeStore {
  private readonly filePath: string | null;
  private readonly wakes = new Map<string, Wake>();

  constructor(filePath?: string) {
    this.filePath = filePath ?? null;
    if (!this.filePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as { wakes?: Wake[] };
      for (const w of raw.wakes ?? []) this.wakes.set(w.id, w);
    } catch {
      // Missing/corrupt file — start empty rather than fail a session's boot over it.
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ wakes: [...this.wakes.values()] }, null, 2),
      "utf-8",
    );
  }

  addTimer(sessionId: string, fireAt: Date, note = ""): Wake {
    const w = makeWake({
      sessionId,
      kind: WAKE_KIND_TIMER,
      fireAt: fireAt.toISOString(),
      jobId: null,
      eventKey: null,
      note,
    });
    this.wakes.set(w.id, w);
    this.persist();
    return w;
  }

  addCompletion(sessionId: string, jobId: string, note = ""): Wake {
    const w = makeWake({ sessionId, kind: WAKE_KIND_COMPLETION, fireAt: null, jobId, eventKey: null, note });
    this.wakes.set(w.id, w);
    this.persist();
    return w;
  }

  addEvent(sessionId: string, eventKey: string, note = ""): Wake {
    const w = makeWake({ sessionId, kind: WAKE_KIND_EVENT, fireAt: null, jobId: null, eventKey, note });
    this.wakes.set(w.id, w);
    this.persist();
    return w;
  }

  /** Timer wakes whose fire time has passed, plus completion/event wakes already marked due. */
  due(now: Date = new Date()): Wake[] {
    const out: Wake[] = [];
    for (const w of this.wakes.values()) {
      if (w.state !== WAKE_STATE_PENDING && w.state !== WAKE_STATE_DUE) continue;
      if (w.kind === WAKE_KIND_TIMER && w.fireAt && new Date(w.fireAt).getTime() <= now.getTime()) {
        out.push(w);
      } else if ((w.kind === WAKE_KIND_COMPLETION || w.kind === WAKE_KIND_EVENT) && w.state === WAKE_STATE_DUE) {
        out.push(w);
      }
    }
    return out;
  }

  /** Mark pending completion wakes for `jobId` as due (the job exited). Returns the newly-due
   * wakes. */
  completeJob(jobId: string): Wake[] {
    return this.markDue((w) => w.kind === WAKE_KIND_COMPLETION && w.jobId === jobId);
  }

  /** Mark pending on-event wakes for `eventKey` as due (a connector/webhook fired). Returns
   * the newly-due wakes. */
  fireEvent(eventKey: string): Wake[] {
    return this.markDue((w) => w.kind === WAKE_KIND_EVENT && w.eventKey === eventKey);
  }

  private markDue(pred: (w: Wake) => boolean): Wake[] {
    const fired: Wake[] = [];
    for (const w of this.wakes.values()) {
      if (w.state === WAKE_STATE_PENDING && pred(w)) {
        w.state = WAKE_STATE_DUE;
        fired.push(w);
      }
    }
    if (fired.length) this.persist();
    return fired;
  }

  markFired(wakeId: string): void {
    const w = this.wakes.get(wakeId);
    if (!w) return;
    w.state = WAKE_STATE_FIRED;
    this.persist();
  }

  pending(sessionId?: string): Wake[] {
    return [...this.wakes.values()].filter(
      (w) => w.state !== WAKE_STATE_FIRED && (sessionId === undefined || w.sessionId === sessionId),
    );
  }
}

// ---------------------------------------------------------------------------------------
// Tools a session registers for itself
// ---------------------------------------------------------------------------------------

const OFFSET_RE = /Z$|[+-]\d{2}:?\d{2}$/i;

/** Parse an ISO-ish timestamp; a bare one (no "Z"/offset) is read as UTC — same contract as
 * `sleep_until`'s docstring, and deliberately NOT the same rule store.ts's schedule `fireAt`
 * uses (that one defaults naive timestamps to the machine's local zone). Different callers,
 * different documented conventions — both ported as-is from their respective Python modules. */
function parseIsoAssumingUtc(iso: string): Date | null {
  const trimmed = iso.trim();
  const normalized = OFFSET_RE.test(trimmed) ? trimmed : `${trimmed}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const SLEEP_UNTIL_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "sleep_until",
    description:
      "Suspend and wake this session at an ISO-8601 timestamp (timezone-aware; bare " +
      "timestamps are read as UTC). Use it for polling/waiting without burning context while " +
      "idle — for a relative wait ('check again in 5 minutes'), compute the timestamp from " +
      "the `Now:` line in your context.",
    parameters: {
      type: "object",
      properties: {
        when_iso: { type: "string", description: "ISO-8601 timestamp to wake at." },
        note: { type: "string", description: "Optional note recorded on the wake, shown when it fires." },
      },
      required: ["when_iso"],
    },
  },
};

const WAKE_ON_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "wake_on",
    description: "Suspend and wake this session when a backgrounded job (`job_id`) completes.",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        note: { type: "string" },
      },
      required: ["job_id"],
    },
  },
};

const WAKE_ON_EVENT_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "wake_on_event",
    description:
      "Suspend and wake this session when a named event (`event_key`) fires — e.g. a " +
      "connector/webhook signal an Ops agent watches for.",
    parameters: {
      type: "object",
      properties: {
        event_key: { type: "string" },
        note: { type: "string" },
      },
      required: ["event_key"],
    },
  },
};

/** Tools a session calls to schedule its own resumption. Not gated — a session suspending
 * itself has no external side effect at call time, same as OpenWorker's ungated originals. */
export function createSelfWakeTools(store: WakeStore, sessionId: string): ToolDefinition[] {
  const metadata = {
    category: "automation",
    riskLevel: "low" as const,
    risk: "write_local" as const,
    requiresApproval: false,
    capabilities: ["selfwake"],
  };

  const sleepUntil: ToolDefinition = {
    name: "sleep_until",
    schema: SLEEP_UNTIL_SCHEMA,
    metadata,
    execute: async (args) => {
      const whenIso = asString(args.when_iso);
      if (!whenIso) return { error: "when_iso is required" };
      const when = parseIsoAssumingUtc(whenIso);
      if (!when) return { error: `invalid when_iso: ${whenIso}` };
      const note = asString(args.note) ?? "";
      const w = store.addTimer(sessionId, when, note);
      return { ok: true, wake_id: w.id, fire_at: w.fireAt };
    },
  };

  const wakeOn: ToolDefinition = {
    name: "wake_on",
    schema: WAKE_ON_SCHEMA,
    metadata,
    execute: async (args) => {
      const jobId = asString(args.job_id);
      if (!jobId) return { error: "job_id is required" };
      const note = asString(args.note) ?? "";
      const w = store.addCompletion(sessionId, jobId, note);
      return { ok: true, wake_id: w.id, job_id: jobId };
    },
  };

  const wakeOnEvent: ToolDefinition = {
    name: "wake_on_event",
    schema: WAKE_ON_EVENT_SCHEMA,
    metadata,
    execute: async (args) => {
      const eventKey = asString(args.event_key);
      if (!eventKey) return { error: "event_key is required" };
      const note = asString(args.note) ?? "";
      const w = store.addEvent(sessionId, eventKey, note);
      return { ok: true, wake_id: w.id, event_key: eventKey };
    },
  };

  return [sleepUntil, wakeOn, wakeOnEvent];
}
