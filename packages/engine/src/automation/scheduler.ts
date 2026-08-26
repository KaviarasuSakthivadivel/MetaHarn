/**
 * Scheduler — the tick loop that fires due ScheduledTasks.
 *
 * Policy (ported from OpenWorker's coworker/automation/scheduler.py): **run-once-catch-up**
 * for runs missed while the process was down (due tasks fire once on `start()`, before the
 * first interval tick), and **skip-on-overlap** (don't stack a run if the previous one is
 * still going). Execution itself is injected as `runner(task, trigger) -> Promise<TaskRun>` so
 * this module stays independent of Engine — it never imports engine.ts.
 *
 * Python's version runs on asyncio's task model (`asyncio.create_task` per due task, tracked in
 * a set so shutdown can cancel/await them). This package doesn't need that: `setInterval` plus
 * plain fire-and-forget promises does the same job on Node's single event loop — a promise
 * that's still pending when `stop()` is called just gets awaited there instead of cancelled
 * (there's no cooperative-cancellation primitive to hook here without engine.ts's AbortSignal,
 * which this module deliberately doesn't depend on).
 */
import type { ScheduledTask, TaskRun, TaskRunTrigger } from "./models.js";
import { createTaskRun } from "./models.js";
import type { TaskStore } from "./store.js";

export type Runner = (task: ScheduledTask, trigger: TaskRunTrigger) => Promise<TaskRun>;

export interface SchedulerOptions {
  /** Poll interval, ms. Default 30s — matches OpenWorker's `tick_seconds=30.0`. */
  tickMs?: number;
  /** An extra per-tick hook (self-wake resumption: resume sessions whose wakes are due). Runs
   * after due tasks are spawned each tick, awaited, but its failure doesn't stop the loop. */
  extraTick?: () => Promise<void>;
  /** Failures are swallowed (a bad tick must never kill the loop) but always reported here
   * instead of only `console.error` — the host decides where scheduler errors surface. */
  onError?: (err: unknown, context: string) => void;
}

export class Scheduler {
  private readonly store: TaskStore;
  private readonly runner: Runner;
  private readonly tickMs: number;
  private readonly extraTick?: () => Promise<void>;
  private readonly onError?: (err: unknown, context: string) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  /** Overlap guard — a task id is in here for the exact duration of its run. */
  private readonly runningIds = new Set<string>();
  /** Keeps every in-flight run referenced so stop() can await them (shutdown must not let a
   * spawned run outlive the scheduler, same contract as Python's `_spawned`). */
  private readonly spawned = new Set<Promise<unknown>>();

  constructor(store: TaskStore, runner: Runner, opts: SchedulerOptions = {}) {
    this.store = store;
    this.runner = runner;
    this.tickMs = opts.tickMs ?? 30_000;
    this.extraTick = opts.extraTick;
    this.onError = opts.onError;
  }

  start(): void {
    if (this.timer !== null) return;
    // Catch-up pass fires immediately — not queued behind the first tickMs wait — so anything
    // that came due while the process was down runs right away.
    this.spawnTick("catchup");
    this.timer = setInterval(() => this.spawnTick("schedule"), this.tickMs);
    // A pending interval keeps Node alive; unref so a host process whose only remaining work
    // is this scheduler can still exit (start() is called once per process either way).
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.allSettled([...this.spawned]);
    this.spawned.clear();
  }

  private spawnTick(trigger: TaskRunTrigger): void {
    const p = this.tick(trigger).catch((err) => this.reportError(err, "scheduler tick"));
    this.track(p);
  }

  private track(p: Promise<unknown>): void {
    this.spawned.add(p);
    void p.finally(() => this.spawned.delete(p));
  }

  private async tick(trigger: TaskRunTrigger): Promise<void> {
    for (const task of this.store.due()) {
      // Spawn, don't await: a run can suspend on a parked approval, and one blocked
      // automation must never stall the scheduler loop, other due tasks, or self-wake
      // resumption. Overlap is still guarded inside runTask via runningIds.
      this.track(
        this.runTask(task, trigger).catch((err) =>
          this.reportError(err, `scheduled task ${task.id}`),
        ),
      );
    }
    if (this.extraTick) {
      try {
        await this.extraTick();
      } catch (err) {
        this.reportError(err, "scheduler extra_tick (wake resume)");
      }
    }
  }

  /** Run one task now (used by both the tick loop and a "run now" manual trigger). Resolves to
   * undefined, not a rejection, when skipped by the overlap guard. */
  async runTask(task: ScheduledTask, trigger: TaskRunTrigger): Promise<TaskRun | undefined> {
    if (this.runningIds.has(task.id)) return undefined; // skip-on-overlap
    this.runningIds.add(task.id);
    let run: TaskRun;
    try {
      run = await this.runner(task, trigger);
    } catch (err) {
      run = createTaskRun({ taskId: task.id, trigger });
      run.status = "error";
      run.error = err instanceof Error ? err.message : String(err);
      run.finishedAt = run.startedAt;
      this.store.addRun(run);
    } finally {
      this.runningIds.delete(task.id);
    }
    // Advance the task (runCount/lastRun) — save() recomputes nextRun from the new state, so
    // a one-shot naturally stops being due and a maxRuns-limited cron naturally exhausts.
    const fresh = this.store.get(task.id);
    if (fresh) {
      fresh.runCount += 1;
      fresh.lastRun = run.startedAt;
      fresh.lastStatus = run.status;
      this.store.save(fresh);
    }
    return run;
  }

  private reportError(err: unknown, context: string): void {
    this.onError?.(err, context);
  }
}
