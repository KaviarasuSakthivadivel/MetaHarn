/**
 * Automation data model — a scheduled task is its own persistent entity: create it once, and
 * each fire is a fresh run of its `instructions`, recorded in the task's own run history.
 *
 * Ported from OpenWorker's coworker/automation/models.py. Two deliberate simplifications from
 * the Python dataclasses:
 *  - No to_dict()/from_dict(): ScheduledTask/TaskRun are plain interfaces, so `JSON.stringify`/
 *    `JSON.parse` round-trip them (including the nested `schedule`) without a hydration step —
 *    store.ts uses that directly.
 *  - All "Optional[X] = None" fields are typed `X | null` (never `undefined`) and always
 *    populated by the factory functions below, so a task/run is always a complete plain object
 *    — better-sqlite3 rejects `undefined` bind parameters, and this sidesteps that entirely.
 *
 * Time fields are epoch SECONDS (matching Python's `time.time()`), not epoch-ms — every module
 * in this package that reads/writes `createdAt`/`nextRun`/etc. agrees on that unit.
 */
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------------------

export type ScheduleKind = "cron" | "once";

export interface Schedule {
  kind: ScheduleKind;
  /** 5-field cron (seconds default to :00), for kind:"cron". */
  cron: string | null;
  /** ISO datetime, for kind:"once". */
  fireAt: string | null;
  /** IANA tz name, or "local" for the machine's clock (the local-first default). */
  timezone: string;
}

export function makeSchedule(input: Partial<Schedule> & Pick<Schedule, "kind">): Schedule {
  return {
    kind: input.kind,
    cron: input.cron ?? null,
    fireAt: input.fireAt ?? null,
    timezone: input.timezone ?? "local",
  };
}

// Indexed by cron day-of-week: 0 and 7 are Sunday, 1 is Monday … 6 is Saturday. Must start at
// Sunday — indexing a Monday-first array by the cron dow labels every weekly schedule one day
// late (dow 1/Monday would render "Tuesday", dow 0/Sunday would render "Monday").
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function humanTime(hour: number, minute: number): string {
  const ampm = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 || 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

/** Best-effort human label ("Every day at ~7:10 PM"); falls back to the raw cron for anything
 * with ranges/steps/lists this simple heuristic doesn't try to describe. */
export function scheduleHuman(s: Schedule): string {
  if (s.kind === "once") return `Once at ${s.fireAt}`;
  const cron = s.cron ?? "";
  const parts = cron.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return cron || "?";
  const [minute, hour, dom, month, dow] = parts;
  void month;
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return cron; // non-trivial cron — show as-is
  const t = humanTime(h, m);
  if (dom === "*" && dow === "*") return `Every day at ~${t}`;
  if (dom === "*" && /^\d+$/.test(dow)) return `Every ${DOW[Number(dow) % 7]} at ~${t}`;
  if (/^\d+$/.test(dom) && dow === "*") return `Monthly on day ${dom} at ~${t}`;
  return cron;
}

// ---------------------------------------------------------------------------------------
// Standing scoped approvals (a rule entry is "tool" or "tool target", never ambiguous since
// tool names never contain spaces). A grant is only accepted when it names BOTH a tool and a
// non-empty target — see grantEntries below; ruleEntry/ruleParts alone don't enforce that,
// since a bare tool name is still a valid (legacy, unscoped) entry once it's already on a task.
// ---------------------------------------------------------------------------------------

export function ruleEntry(tool: string, target?: string | null): string {
  return target ? `${tool} ${target}` : tool;
}

/** Inverse of ruleEntry: "tool target" -> [tool, target]; a bare "tool" -> [tool, null]. */
export function ruleParts(entry: string): [tool: string, target: string | null] {
  const trimmed = entry.trim();
  const i = trimmed.indexOf(" ");
  if (i === -1) return [trimmed, null];
  const target = trimmed.slice(i + 1).trim();
  return [trimmed.slice(0, i), target || null];
}

export interface ProposedPermission {
  tool: string;
  target: string;
  access: "read" | "write";
}

/**
 * Validate a proposed `permissions` list (from the create-tool schema) down to the entries
 * actually grantable. Only `access: "write"` items become grants, and only when both `tool`
 * and `target` are non-empty — this is the one invariant every caller of this module relies
 * on: a grant entry NEVER binds to "any target" the way a bare tool name would. Reads are
 * disclosure-only (rendered on a consent card elsewhere), never stored here.
 *
 * OpenWorker's Python also required the tool to declare a target argument via a connectors
 * registry (`target_arg_for`, which excludes exec/destructive tools by construction) — that
 * registry doesn't exist in this package. `isGrantable` is the seam a later connectors/
 * permissions workstream can wire in without touching this file; it defaults to accept-all
 * (subject to the tool+target requirement above), which is fail-open only in the sense that
 * *this* module no longer independently excludes exec tools — the permission engine downstream
 * still gates on each tool's declared `risk`.
 */
export function grantEntries(
  permissions: unknown,
  opts?: { isGrantable?: (tool: string) => boolean },
): string[] {
  const isGrantable = opts?.isGrantable ?? (() => true);
  const entries: string[] = [];
  if (!Array.isArray(permissions)) return entries;
  for (const item of permissions) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (String(rec.access ?? "").toLowerCase() !== "write") continue;
    const tool = String(rec.tool ?? "").trim();
    const target = String(rec.target ?? "").trim();
    if (!tool || !target || !isGrantable(tool)) continue;
    const entry = ruleEntry(tool, target);
    if (!entries.includes(entry)) entries.push(entry);
  }
  return entries;
}

// ---------------------------------------------------------------------------------------
// ScheduledTask
// ---------------------------------------------------------------------------------------

export interface ScheduledTask {
  id: string;
  title: string;
  instructions: string;
  schedule: Schedule;
  workspace: string;
  /** Where it was launched from (a reference, e.g. a chat surface name). */
  originSurface: string;
  originSessionId: string;
  agent: string;
  /** The task's OWN thread, distinct from any one run's thread — f"__task__{id}". */
  taskSessionId: string;
  model: string | null;
  notifyOnCompletion: boolean;
  /** Extra messaging target beyond the origin surface (e.g. "telegram:123"). */
  notifyTarget: string | null;
  alwaysAllowedTools: string[];
  alwaysAllowedCommands: string[];
  enabled: boolean;
  /** Epoch seconds. */
  createdAt: number;
  updatedAt: number;
  /** Epoch seconds; computed by the store (TaskStore.save), never set directly. */
  nextRun: number | null;
  lastRun: number | null;
  lastStatus: string | null;
  runCount: number;
  maxRuns: number | null;
  /** Sidebar unread tracking: runs started after this mark count as "unseen"; opening the
   * automation's detail advances it. 0 = never opened. */
  seenRunsAt: number;
}

export interface CreateScheduledTaskInput {
  title: string;
  instructions: string;
  schedule: Schedule;
  workspace: string;
  originSurface?: string;
  originSessionId?: string;
  agent?: string;
  model?: string;
  notifyOnCompletion?: boolean;
  notifyTarget?: string;
  alwaysAllowedTools?: string[];
  maxRuns?: number;
}

function epochNow(): number {
  return Date.now() / 1000;
}

function shortId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

export function createScheduledTask(input: CreateScheduledTaskInput): ScheduledTask {
  const id = shortId("task");
  const now = epochNow();
  return {
    id,
    title: input.title,
    instructions: input.instructions,
    schedule: input.schedule,
    workspace: input.workspace,
    // OpenWorker defaulted these to its own product surface name ("cowork"); this is a
    // generic engine package with no such default, so callers get a neutral placeholder.
    originSurface: input.originSurface ?? "agent",
    originSessionId: input.originSessionId ?? "",
    agent: input.agent ?? "agent",
    taskSessionId: `__task__${id}`,
    model: input.model ?? null,
    notifyOnCompletion: input.notifyOnCompletion ?? true,
    notifyTarget: input.notifyTarget ?? null,
    alwaysAllowedTools: input.alwaysAllowedTools ?? [],
    alwaysAllowedCommands: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
    nextRun: null,
    lastRun: null,
    lastStatus: null,
    runCount: 0,
    maxRuns: input.maxRuns ?? null,
    seenRunsAt: 0,
  };
}

/** Target-bound entries as {tool: {targets}} — the shape a permission engine matches against
 * a call's declared target argument. */
export function standingRules(task: ScheduledTask): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const entry of task.alwaysAllowedTools) {
    const [tool, target] = ruleParts(entry);
    if (tool && target) {
      if (!out.has(tool)) out.set(tool, new Set());
      out.get(tool)!.add(target);
    }
  }
  return out;
}

/** Legacy name-only entries (no target binding) — back-compatible with a bare tool-name rule. */
export function nameAllowedTools(task: ScheduledTask): Set<string> {
  const out = new Set<string>();
  for (const entry of task.alwaysAllowedTools) {
    const [tool, target] = ruleParts(entry);
    if (tool && target === null) out.add(tool);
  }
  return out;
}

export function addRule(task: ScheduledTask, tool: string, target: string): boolean {
  const entry = ruleEntry(tool, target);
  if (!tool || !target || task.alwaysAllowedTools.includes(entry)) return false;
  task.alwaysAllowedTools.push(entry);
  return true;
}

export function revokeRule(task: ScheduledTask, entry: string): boolean {
  const i = task.alwaysAllowedTools.indexOf(entry);
  if (i === -1) return false;
  task.alwaysAllowedTools.splice(i, 1);
  return true;
}

export interface ScheduledTaskPublic {
  id: string;
  title: string;
  instructions: string;
  schedule: string;
  scheduleRaw: Schedule;
  workspace: string;
  agent: string;
  enabled: boolean;
  nextRun: number | null;
  lastRun: number | null;
  lastStatus: string | null;
  runCount: number;
  notifyOnCompletion: boolean;
  seenRunsAt: number;
  /** Structured for a task-detail revoke list; `entry` is the revokeRule() handle. */
  alwaysAllowed: { entry: string; tool: string; target: string | null }[];
}

/** Status shape for an API/UI: no instructions truncation, never any secret. */
export function taskPublic(task: ScheduledTask): ScheduledTaskPublic {
  const uniqueSorted = [...new Set(task.alwaysAllowedTools)].sort();
  return {
    id: task.id,
    title: task.title,
    instructions: task.instructions,
    schedule: scheduleHuman(task.schedule),
    scheduleRaw: task.schedule,
    workspace: task.workspace,
    agent: task.agent,
    enabled: task.enabled,
    nextRun: task.nextRun,
    lastRun: task.lastRun,
    lastStatus: task.lastStatus,
    runCount: task.runCount,
    notifyOnCompletion: task.notifyOnCompletion,
    seenRunsAt: task.seenRunsAt,
    alwaysAllowed: uniqueSorted.map((entry) => {
      const [tool, target] = ruleParts(entry);
      return { entry, tool, target };
    }),
  };
}

// ---------------------------------------------------------------------------------------
// TaskRun
// ---------------------------------------------------------------------------------------

export type TaskRunStatus = "running" | "ok" | "error" | "skipped";
export type TaskRunTrigger = "schedule" | "manual" | "catchup";

export interface TaskRun {
  taskId: string;
  runId: string;
  /** Epoch seconds. */
  startedAt: number;
  finishedAt: number | null;
  status: TaskRunStatus;
  resultText: string | null;
  artifacts: string[];
  error: string | null;
  trigger: TaskRunTrigger;
  /** The run's own conversation thread — persisted + continuable ("__run__<runId>"). */
  sessionId: string;
}

export interface CreateTaskRunInput {
  taskId: string;
  trigger?: TaskRunTrigger;
  status?: TaskRunStatus;
}

export function createTaskRun(input: CreateTaskRunInput): TaskRun {
  const runId = shortId("run");
  return {
    taskId: input.taskId,
    runId,
    startedAt: epochNow(),
    finishedAt: null,
    status: input.status ?? "running",
    resultText: null,
    artifacts: [],
    error: null,
    trigger: input.trigger ?? "schedule",
    sessionId: `__run__${runId}`,
  };
}
