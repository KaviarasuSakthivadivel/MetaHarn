/**
 * TaskStore — better-sqlite3-backed store for scheduled tasks + run history.
 *
 * Tasks/runs are stored as JSON blobs (mirroring `ScheduledTask`/`TaskRun` 1:1 — see
 * models.ts's docstring on why no hydration step is needed) with a few indexed columns
 * (`next_run`, `enabled`) so the scheduler can cheaply find what's due. `next_run` is computed
 * with the `cron-parser` package, honoring the task's timezone.
 *
 * Ported from OpenWorker's coworker/automation/store.py. One deliberate simplification: the
 * Python version guards every query with `threading.RLock` because the scheduler and request
 * handlers touch the connection from different OS threads. better-sqlite3 is synchronous and
 * this package runs on one Node event loop (see engine.ts's module docstring) — a call either
 * runs to completion before the next one starts or it doesn't start yet, so there's no
 * interleaving to guard against and no lock is needed here.
 */
import Database from "better-sqlite3";
import { CronExpressionParser } from "cron-parser";
import type { ScheduledTask, TaskRun } from "./models.js";

function epochNow(): number {
  return Date.now() / 1000;
}

function isValidTimeZone(tz: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidCron(cron: string): boolean {
  try {
    CronExpressionParser.parse(cron);
    return true;
  } catch {
    return false;
  }
}

/** UTC-offset (ms) in effect for `timeZone` at instant `atMs` — the "what wall-clock does this
 * zone show right now" trick via Intl, since Node ships full ICU and this needs no extra dep. */
function tzOffsetMs(atMs: number, timeZone: string): number {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(atMs))) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24, // Intl's h23 cycle prints midnight as "24" in some locales
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - atMs;
}

/** Interpret naive wall-clock components as a moment IN `timeZone`, returning epoch ms.
 * Two-pass refinement (the standard technique behind libraries like date-fns-tz's
 * `zonedTimeToUtc`): a single pass can land an hour off right at a DST transition. */
function wallTimeInZoneToEpochMs(
  y: number,
  month0: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): number {
  const guess = Date.UTC(y, month0, d, h, mi, s);
  const pass2 = guess - tzOffsetMs(guess, timeZone);
  return guess - tzOffsetMs(pass2, timeZone);
}

const HAS_OFFSET_RE = /Z$|[+-]\d{2}:?\d{2}$/i;
const NAIVE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\s*$/;

/**
 * Resolve a schedule's `fireAt` (+ `timezone`) to epoch seconds, or null if unparseable.
 * Mirrors OpenWorker's store.py: a string that already carries an offset/"Z" is trusted as-is
 * (never re-zoned); a naive one is read as wall-clock time IN the declared zone. "local" (or
 * an unrecognized IANA name — fails open the same way Python's `_tz` helper does) defers to
 * the machine's own clock, which is DST-correct for the fire DATE by construction since
 * `Date`'s local constructor asks the OS, not a frozen offset computed at save time.
 */
function resolveFireAtEpoch(fireAt: string, timezone: string): number | null {
  const trimmed = fireAt.trim();
  if (HAS_OFFSET_RE.test(trimmed)) {
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : ms / 1000;
  }
  const m = NAIVE_DATETIME_RE.exec(trimmed);
  if (!m) {
    const ms = Date.parse(trimmed); // best-effort for any other ISO-ish shape
    return Number.isNaN(ms) ? null : ms / 1000;
  }
  const [, yy, mo, dd, hh, mi, ss] = m;
  const y = Number(yy);
  const month0 = Number(mo) - 1;
  const d = Number(dd);
  const h = Number(hh);
  const min = Number(mi);
  const s = ss ? Number(ss) : 0;
  if (timezone.toLowerCase() !== "local" && isValidTimeZone(timezone)) {
    return wallTimeInZoneToEpochMs(y, month0, d, h, min, s, timezone) / 1000;
  }
  const local = new Date(y, month0, d, h, min, s);
  return Number.isNaN(local.getTime()) ? null : local.getTime() / 1000;
}

/** Next fire time (epoch seconds), or null if the task is exhausted/one-shot-past. */
export function computeNextRun(task: ScheduledTask, opts?: { after?: number }): number | null {
  const sched = task.schedule;
  const now = opts?.after ?? epochNow();
  if (sched.kind === "once") {
    if (!sched.fireAt) return null;
    const ts = resolveFireAtEpoch(sched.fireAt, sched.timezone);
    return ts !== null && task.runCount === 0 && ts > now ? ts : null;
  }
  if (!sched.cron || !isValidCron(sched.cron)) return null;
  if (task.maxRuns !== null && task.runCount >= task.maxRuns) return null;
  const tz =
    sched.timezone.toLowerCase() !== "local" && isValidTimeZone(sched.timezone)
      ? sched.timezone
      : undefined;
  try {
    const interval = CronExpressionParser.parse(sched.cron, {
      currentDate: new Date(now * 1000),
      tz,
    });
    return interval.next().toDate().getTime() / 1000;
  } catch {
    return null;
  }
}

interface BlobRow {
  data: string;
}

export class TaskStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run REAL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        started_at REAL NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id, started_at DESC);
    `);
  }

  // -- tasks --------------------------------------------------------------------------

  save(task: ScheduledTask): ScheduledTask {
    task.updatedAt = epochNow();
    task.nextRun = task.enabled ? computeNextRun(task) : null;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO scheduled_tasks (id, enabled, next_run, data) VALUES (?, ?, ?, ?)",
      )
      .run(task.id, task.enabled ? 1 : 0, task.nextRun, JSON.stringify(task));
    return task;
  }

  get(taskId: string): ScheduledTask | undefined {
    const row = this.db.prepare("SELECT data FROM scheduled_tasks WHERE id = ?").get(taskId) as
      | BlobRow
      | undefined;
    return row ? (JSON.parse(row.data) as ScheduledTask) : undefined;
  }

  list(): ScheduledTask[] {
    const rows = this.db
      .prepare("SELECT data FROM scheduled_tasks ORDER BY next_run IS NULL, next_run")
      .all() as BlobRow[];
    return rows.map((r) => JSON.parse(r.data) as ScheduledTask);
  }

  delete(taskId: string): boolean {
    const info = this.db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(taskId);
    this.db.prepare("DELETE FROM task_runs WHERE task_id = ?").run(taskId);
    return info.changes > 0;
  }

  due(now?: number): ScheduledTask[] {
    const at = now ?? epochNow();
    const rows = this.db
      .prepare(
        "SELECT data FROM scheduled_tasks WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ? ORDER BY next_run",
      )
      .all(at) as BlobRow[];
    return rows.map((r) => JSON.parse(r.data) as ScheduledTask);
  }

  // -- runs ---------------------------------------------------------------------------

  addRun(run: TaskRun): TaskRun {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO task_runs (run_id, task_id, started_at, data) VALUES (?, ?, ?, ?)",
      )
      .run(run.runId, run.taskId, run.startedAt, JSON.stringify(run));
    return run;
  }

  findRun(runId: string): TaskRun | undefined {
    const row = this.db.prepare("SELECT data FROM task_runs WHERE run_id = ?").get(runId) as
      | BlobRow
      | undefined;
    return row ? (JSON.parse(row.data) as TaskRun) : undefined;
  }

  /** The owning task of a run session ("__run__<runId>"), or undefined. How standing scoped
   * approvals resolve which automation a live approval belongs to. */
  taskForRunSession(sessionId: string): ScheduledTask | undefined {
    const prefix = "__run__";
    if (!sessionId.startsWith(prefix)) return undefined;
    const run = this.findRun(sessionId.slice(prefix.length));
    return run ? this.get(run.taskId) : undefined;
  }

  runs(taskId: string, limit = 50): TaskRun[] {
    const rows = this.db
      .prepare("SELECT data FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(taskId, limit) as BlobRow[];
    return rows.map((r) => JSON.parse(r.data) as TaskRun);
  }

  close(): void {
    this.db.close();
  }
}
