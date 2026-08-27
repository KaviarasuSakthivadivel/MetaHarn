/**
 * Automations for the server surface — its own TaskStore + Scheduler (automations.db in this
 * process's state dir), separate from apps/desktop's Electron automation runtime by the same
 * "no shared store between processes" disclosure already in session.ts's module doc.
 *
 * A run is an unattended ServerSession: no human is present to click "allow", so anything not
 * pre-approved via the task's own `alwaysAllowedTools` is denied immediately rather than
 * hanging (see session.ts's `unattended` option).
 */
import { TaskStore } from "@metaharn/engine/src/automation/store.js";
import {
  createScheduledTask,
  createTaskRun,
  makeSchedule,
  nameAllowedTools,
  standingRules,
  taskPublic,
  type ScheduledTask,
  type ScheduledTaskPublic,
  type Schedule,
  type TaskRun,
  type TaskRunTrigger,
} from "@metaharn/engine/src/automation/models.js";
import { Scheduler } from "@metaharn/engine/src/automation/scheduler.js";
import type { Wake } from "@metaharn/engine/src/automation/selfwake.js";
import { statePath } from "./state.js";
import { createSession, findSessionPath } from "./session.js";
import { wakeStore } from "./selfWakeApi.js";

let store: TaskStore | undefined;
function taskStore(): TaskStore {
  if (!store) store = new TaskStore(statePath("automations.db"));
  return store;
}

let scheduler: Scheduler | undefined;

async function runTask(task: ScheduledTask, trigger: TaskRunTrigger): Promise<TaskRun> {
  const run = createTaskRun({ taskId: task.id, trigger });
  try {
    const session = await createSession(task.workspace, undefined, {
      unattended: true,
      autoAllowTools: [...nameAllowedTools(task)],
      taskRules: standingRules(task),
    });
    let resultText = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "text_delta") resultText += event.delta;
    });
    await session.prompt(task.instructions);
    unsubscribe();
    run.status = session.errorMessage ? "error" : "ok";
    run.error = session.errorMessage ?? null;
    run.resultText = resultText || null;
    session.dispose();
  } catch (err) {
    run.status = "error";
    run.error = err instanceof Error ? err.message : String(err);
  }
  run.finishedAt = Date.now() / 1000;
  taskStore().addRun(run);
  return run;
}

function wakeMessage(wake: Wake): string {
  const note = wake.note ? ` Note you left yourself: ${wake.note}` : "";
  return `[Self-wake] The time you asked to be woken at (${wake.fireAt}) has arrived.${note} Continue where you left off.`;
}

/** Resumes every session with a due timer wake. Piggybacks on this same Scheduler's tick
 * instead of running a second timer loop — Scheduler.start() already fires this once per
 * tick (30s) right after spawning any due scheduled tasks. Best-effort per wake: one session
 * failing to resume must not stop the others' wakes from firing. */
async function resumeDueWakes(): Promise<void> {
  for (const wake of wakeStore().due()) {
    try {
      const sessionPath = findSessionPath(wake.sessionId);
      if (!sessionPath) {
        // The session was deleted since the wake was scheduled — nothing to resume into.
        continue;
      }
      const session = await createSession("", sessionPath, { unattended: true });
      await session.prompt(wakeMessage(wake));
      session.dispose();
    } catch (err) {
      console.warn(`[metaharn-server] self-wake ${wake.id} failed to resume:`, (err as Error).message);
    } finally {
      wakeStore().markFired(wake.id);
    }
  }
}

export function startAutomationScheduler(): void {
  if (scheduler) return;
  scheduler = new Scheduler(taskStore(), runTask, {
    extraTick: resumeDueWakes,
    onError: (err, context) => console.warn(`[metaharn-server] automation error (${context}):`, err),
  });
  scheduler.start();
}

export async function stopAutomationScheduler(): Promise<void> {
  await scheduler?.stop();
  scheduler = undefined;
}

export interface AutomationListItem extends ScheduledTaskPublic {
  recentRuns: TaskRun[];
}

export function listAutomations(): AutomationListItem[] {
  return taskStore()
    .list()
    .map((task) => ({ ...taskPublic(task), recentRuns: taskStore().runs(task.id, 5) }));
}

export interface CreateAutomationInput {
  title: string;
  instructions: string;
  workspace: string;
  schedule: Partial<Schedule> & Pick<Schedule, "kind">;
  alwaysAllowedTools?: string[];
}

export function createAutomation(input: CreateAutomationInput): ScheduledTaskPublic {
  const task = createScheduledTask({
    title: input.title,
    instructions: input.instructions,
    workspace: input.workspace,
    schedule: makeSchedule(input.schedule),
    alwaysAllowedTools: input.alwaysAllowedTools,
    originSurface: "web",
  });
  taskStore().save(task);
  return taskPublic(task);
}

export interface UpdateAutomationInput {
  title?: string;
  instructions?: string;
  enabled?: boolean;
  schedule?: Partial<Schedule> & Pick<Schedule, "kind">;
}

export function updateAutomation(id: string, patch: UpdateAutomationInput): ScheduledTaskPublic | undefined {
  const task = taskStore().get(id);
  if (!task) return undefined;
  if (patch.title !== undefined) task.title = patch.title;
  if (patch.instructions !== undefined) task.instructions = patch.instructions;
  if (patch.enabled !== undefined) task.enabled = patch.enabled;
  if (patch.schedule !== undefined) task.schedule = makeSchedule(patch.schedule);
  taskStore().save(task);
  return taskPublic(task);
}

export function deleteAutomation(id: string): boolean {
  return taskStore().delete(id);
}

export async function runAutomationNow(id: string): Promise<TaskRun | undefined> {
  const task = taskStore().get(id);
  if (!task || !scheduler) return undefined;
  return scheduler.runTask(task, "manual");
}
