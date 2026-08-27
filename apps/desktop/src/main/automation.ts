/**
 * Automation runtime — a main-process singleton, started once at app startup
 * (main.ts), independent of any window or session. Wires @metaharn/engine's
 * Scheduler/TaskStore to a "runner" that spins up a throwaway, unattended
 * OwnedEngineSession per due task.
 *
 * A one-directional dependency on ownedEngine.ts (this file imports it; ownedEngine.ts does
 * NOT import this file back) — the shared TaskStore reaches every chat session's tool
 * registry via ownedEngine.ts's setSchedulingStore() setter instead, specifically to avoid a
 * circular import between the two.
 *
 * Real, disclosed gap: no Electron background/login-item story yet (see
 * docs/research/openworker-integration.md §7's "OpenWorker assumes an always-on server"
 * callout) — the scheduler only runs while the app is open, and Scheduler's own
 * run-once-catch-up policy means anything missed while closed fires once at next launch,
 * not "on time." Good enough to be genuinely useful; not a substitute for a real background
 * process, which is deliberate later work.
 */
import { join } from "node:path";
import { app } from "electron";
import { Scheduler } from "@metaharn/engine/src/automation/scheduler.js";
import { TaskStore } from "@metaharn/engine/src/automation/store.js";
import {
  createScheduledTask,
  createTaskRun,
  makeSchedule,
  standingRules,
  taskPublic,
  type ScheduledTaskPublic,
  type Schedule,
  type ScheduledTask,
  type TaskRun,
  type TaskRunTrigger,
} from "@metaharn/engine/src/automation/models.js";
import type { ChatMessage } from "@metaharn/engine/src/types.js";
import type { Wake } from "@metaharn/engine/src/automation/selfwake.js";
import { createOwnedEngineSession, findOwnedSessionPath, setSchedulingStore } from "./ownedEngine.js";
import { wakeStore } from "./ownedSelfWake.js";

let scheduler: Scheduler | undefined;
let store: TaskStore | undefined;

function lastAssistantText(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && typeof msg.content === "string" && msg.content) return msg.content;
  }
  return null;
}

async function runScheduledTask(task: ScheduledTask, trigger: TaskRunTrigger): Promise<TaskRun> {
  const run = createTaskRun({ taskId: task.id, trigger });
  store!.addRun(run);
  try {
    const session = await createOwnedEngineSession(task.workspace, {
      unattended: true,
      taskRules: standingRules(task),
    });
    await session.prompt(task.instructions);
    run.resultText = lastAssistantText(session.messages);
    run.status = session.errorMessage ? "error" : "ok";
    run.error = session.errorMessage ?? null;
    session.dispose();
  } catch (err) {
    run.status = "error";
    run.error = (err as Error).message;
  }
  run.finishedAt = Date.now() / 1000;
  store!.addRun(run);
  return run;
}

function wakeMessage(wake: Wake): string {
  const note = wake.note ? ` Note you left yourself: ${wake.note}` : "";
  return `[Self-wake] The time you asked to be woken at (${wake.fireAt}) has arrived.${note} Continue where you left off.`;
}

/** Resumes every owned-engine session with a due timer wake — piggybacks on this same
 * Scheduler's tick instead of running a second timer loop. Best-effort per wake: one session
 * failing to resume must not stop the others' wakes from firing. */
async function resumeDueWakes(): Promise<void> {
  for (const wake of wakeStore().due()) {
    try {
      const sessionPath = findOwnedSessionPath(wake.sessionId);
      if (!sessionPath) continue; // session deleted since the wake was scheduled
      const session = await createOwnedEngineSession("", { resumeSessionPath: sessionPath, unattended: true });
      await session.prompt(wakeMessage(wake));
      session.dispose();
    } catch (err) {
      console.warn(`[metaharn] self-wake ${wake.id} failed to resume:`, (err as Error).message);
    } finally {
      wakeStore().markFired(wake.id);
    }
  }
}

export function startAutomationRuntime(): void {
  if (scheduler) return;
  store = new TaskStore(join(app.getPath("userData"), "automation.db"));
  setSchedulingStore(store);
  scheduler = new Scheduler(store, runScheduledTask, {
    extraTick: resumeDueWakes,
    onError: (err, context) => console.warn(`[metaharn] automation — ${context}:`, (err as Error).message),
  });
  scheduler.start();
  console.log("[metaharn] automation runtime started");
}

export async function stopAutomationRuntime(): Promise<void> {
  await scheduler?.stop();
  scheduler = undefined;
}

// -- CRUD surface for the renderer's Settings > Automations panel ---------------------------
// Reads/writes the SAME store the scheduler above already runs against (started once at
// app.whenReady(), before any window exists to call these) — not a second TaskStore.

export interface AutomationListItem extends ScheduledTaskPublic {
  recentRuns: TaskRun[];
}

export function listAutomationTasks(): AutomationListItem[] {
  if (!store) return [];
  return store.list().map((task) => ({ ...taskPublic(task), recentRuns: store!.runs(task.id, 5) }));
}

export interface CreateAutomationTaskInput {
  title: string;
  instructions: string;
  workspace: string;
  schedule: Partial<Schedule> & Pick<Schedule, "kind">;
}

export function createAutomationTask(input: CreateAutomationTaskInput): ScheduledTaskPublic | undefined {
  if (!store) return undefined;
  const task = createScheduledTask({
    title: input.title,
    instructions: input.instructions,
    workspace: input.workspace,
    schedule: makeSchedule(input.schedule),
    originSurface: "desktop",
  });
  store.save(task);
  return taskPublic(task);
}

export interface UpdateAutomationTaskInput {
  title?: string;
  instructions?: string;
  enabled?: boolean;
  schedule?: Partial<Schedule> & Pick<Schedule, "kind">;
}

export function updateAutomationTask(id: string, patch: UpdateAutomationTaskInput): ScheduledTaskPublic | undefined {
  if (!store) return undefined;
  const task = store.get(id);
  if (!task) return undefined;
  if (patch.title !== undefined) task.title = patch.title;
  if (patch.instructions !== undefined) task.instructions = patch.instructions;
  if (patch.enabled !== undefined) task.enabled = patch.enabled;
  if (patch.schedule !== undefined) task.schedule = makeSchedule(patch.schedule);
  store.save(task);
  return taskPublic(task);
}

export function deleteAutomationTask(id: string): boolean {
  return store ? store.delete(id) : false;
}

export async function runAutomationTaskNow(id: string): Promise<TaskRun | undefined> {
  if (!store || !scheduler) return undefined;
  const task = store.get(id);
  if (!task) return undefined;
  return scheduler.runTask(task, "manual");
}
