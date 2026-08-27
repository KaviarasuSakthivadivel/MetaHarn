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
import { createTaskRun, standingRules, type ScheduledTask, type TaskRun, type TaskRunTrigger } from "@metaharn/engine/src/automation/models.js";
import type { ChatMessage } from "@metaharn/engine/src/types.js";
import { createOwnedEngineSession, setSchedulingStore } from "./ownedEngine.js";

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

export function startAutomationRuntime(): void {
  if (scheduler) return;
  store = new TaskStore(join(app.getPath("userData"), "automation.db"));
  setSchedulingStore(store);
  scheduler = new Scheduler(store, runScheduledTask, {
    onError: (err, context) => console.warn(`[metaharn] automation — ${context}:`, (err as Error).message),
  });
  scheduler.start();
  console.log("[metaharn] automation runtime started");
}

export async function stopAutomationRuntime(): Promise<void> {
  await scheduler?.stop();
  scheduler = undefined;
}
