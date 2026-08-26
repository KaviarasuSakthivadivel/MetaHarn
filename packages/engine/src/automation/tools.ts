/**
 * Agent-facing scheduling tools: create/list/update/delete_scheduled_task.
 *
 * Ported from OpenWorker's coworker/automation/tools.py. `create_scheduled_task` and its
 * siblings that mutate a standing automation are gated (`requiresApproval: true`) so a confirm
 * card renders before the automation exists or changes (approve-at-creation/-edit/-delete);
 * `list_scheduled_tasks` is read-only and ungated. The agent converts natural-language timing
 * ("7:10pm every day") into a cron string itself — this module only validates the result.
 *
 * Tools are origin-bound: a created task records the launching session/workspace so the
 * origin conversation can find the automation's results (its artifacts are real files there).
 */
import {
  createScheduledTask,
  grantEntries,
  makeSchedule,
  scheduleHuman,
  taskPublic,
  type Schedule,
} from "./models.js";
import { isValidCron, type TaskStore } from "./store.js";
import type { ToolDefinition, ToolSchema } from "../types.js";

export interface SchedulingOrigin {
  /** Where it was launched from (a reference, e.g. a chat surface name). */
  surface?: string;
  sessionId?: string;
  agent?: string;
  /** Overrides `defaultWorkspace` when the launching session has its own. */
  workspace?: string;
}

export interface SchedulingToolsOptions {
  origin?: SchedulingOrigin;
  defaultWorkspace: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const CREATE_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "create_scheduled_task",
    description:
      "Create a scheduled automation that re-runs `instructions` on a schedule. Convert the " +
      "user's natural-language timing into a cron expression yourself (e.g. 'every day at " +
      "7:10pm' -> '10 19 * * *'), or pass a one-time `fire_at` ISO datetime. The user confirms " +
      "before it is created.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short label, e.g. 'Daily news briefing'." },
        instructions: {
          type: "string",
          description:
            "What to do on each run, written as a direct command to execute immediately " +
            "(e.g. 'Prepare a market analysis report covering …'). Do NOT restate the " +
            "schedule or timing here — timing belongs in cron/fire_at; this text is handed " +
            "verbatim to the agent every run.",
        },
        cron: { type: "string", description: "5-field cron, e.g. '10 19 * * *'. Omit for one-time." },
        fire_at: { type: "string", description: "ISO datetime for a one-time run. Omit for recurring." },
        timezone: {
          type: "string",
          description:
            "IANA tz, e.g. 'America/New_York'. Defaults to the machine's local time — pass it only to override.",
        },
        permissions: {
          type: "array",
          description:
            "What this automation will touch, surfaced on the creation consent card. List " +
            "every external read and write the instructions imply. Reads (access:'read') are " +
            "disclosure only. Writes (access:'write') become standing grants IF the user " +
            "approves: the automation may then call that exact tool against that exact target " +
            "without asking each run. Targets must be exact (a channel address, a recipient) " +
            "— no wildcards. Omit writes whose target you don't know yet; the run will ask instead.",
          items: {
            type: "object",
            properties: {
              tool: { type: "string", description: "Exact tool name, e.g. 'send_message'." },
              target: { type: "string", description: "The exact target argument value the rule binds to." },
              access: {
                type: "string",
                enum: ["read", "write"],
                description: "'write' proposes a standing grant; 'read' is disclosure.",
              },
            },
            required: ["tool", "target", "access"],
          },
        },
      },
      required: ["title", "instructions"],
    },
  },
};

const UPDATE_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "update_scheduled_task",
    description: "Enable/disable or edit a scheduled task (its instructions, cron, or title).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        enabled: { type: "boolean" },
        instructions: { type: "string" },
        cron: { type: "string" },
        title: { type: "string" },
      },
      required: ["id"],
    },
  },
};

const DELETE_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "delete_scheduled_task",
    description: "Delete a scheduled task and its run history.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
};

const LIST_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "list_scheduled_tasks",
    description: "List the user's scheduled tasks (title, schedule, next run, status).",
    parameters: { type: "object", properties: {} },
  },
};

function createCreateScheduledTaskTool(store: TaskStore, opts: SchedulingToolsOptions): ToolDefinition {
  return {
    name: "create_scheduled_task",
    schema: CREATE_SCHEMA,
    metadata: {
      category: "automation",
      riskLevel: "medium",
      risk: "write_local",
      requiresApproval: true,
      capabilities: ["scheduling"],
    },
    execute: async (args) => {
      const title = asString(args.title);
      const instructions = asString(args.instructions);
      const cron = asString(args.cron);
      const fireAt = asString(args.fire_at);
      const timezone = asString(args.timezone) ?? "local";
      if (!title || !instructions) {
        return { error: "title and instructions are required" };
      }
      if (!cron && !fireAt) {
        return { error: "provide a cron (recurring) or a fire_at ISO datetime (one-time)" };
      }
      if (cron && !isValidCron(cron)) {
        return { error: `invalid cron expression: ${cron}` };
      }
      const schedule: Schedule = makeSchedule({
        kind: fireAt && !cron ? "once" : "cron",
        cron: cron ?? null,
        fireAt: fireAt ?? null,
        timezone,
      });
      const workspace = opts.origin?.workspace || opts.defaultWorkspace;
      // The agent PROPOSES permissions; the human grants them by approving this gated call
      // (the consent card rendered the proposal). Only validated write grants stick — see
      // grantEntries' docstring for the tool+non-empty-target invariant.
      const grants = grantEntries(args.permissions);
      const task = createScheduledTask({
        title,
        instructions,
        schedule,
        workspace,
        originSurface: opts.origin?.surface,
        originSessionId: opts.origin?.sessionId,
        agent: opts.origin?.agent,
        alwaysAllowedTools: grants,
      });
      store.save(task);
      return {
        ok: true,
        id: task.id,
        title: task.title,
        schedule: scheduleHuman(schedule),
        next_run: task.nextRun,
        workspace,
        always_allowed: grants,
      };
    },
  };
}

function createListScheduledTasksTool(store: TaskStore): ToolDefinition {
  return {
    name: "list_scheduled_tasks",
    schema: LIST_SCHEMA,
    metadata: {
      category: "automation",
      riskLevel: "low",
      risk: "read",
      requiresApproval: false,
      capabilities: ["scheduling"],
    },
    execute: async () => ({ tasks: store.list().map(taskPublic) }),
  };
}

function createUpdateScheduledTaskTool(store: TaskStore): ToolDefinition {
  return {
    name: "update_scheduled_task",
    schema: UPDATE_SCHEMA,
    metadata: {
      category: "automation",
      riskLevel: "medium",
      risk: "write_local",
      requiresApproval: true,
      capabilities: ["scheduling"],
    },
    execute: async (args) => {
      const id = asString(args.id);
      if (!id) return { error: "id is required" };
      const task = store.get(id);
      if (!task) return { error: `no such task: ${id}` };

      const cron = asString(args.cron);
      if (cron !== undefined) {
        if (!isValidCron(cron)) return { error: `invalid cron expression: ${cron}` };
        task.schedule.cron = cron;
        task.schedule.kind = "cron";
      }
      if (typeof args.enabled === "boolean") task.enabled = args.enabled;
      const instructions = asString(args.instructions);
      if (instructions !== undefined) task.instructions = instructions;
      const title = asString(args.title);
      if (title !== undefined) task.title = title;

      store.save(task);
      return { ok: true, task: taskPublic(task) };
    },
  };
}

function createDeleteScheduledTaskTool(store: TaskStore): ToolDefinition {
  return {
    name: "delete_scheduled_task",
    schema: DELETE_SCHEMA,
    metadata: {
      category: "automation",
      riskLevel: "medium",
      risk: "write_local",
      requiresApproval: true,
      capabilities: ["scheduling"],
    },
    execute: async (args) => {
      const id = asString(args.id);
      if (!id) return { error: "id is required" };
      return { ok: store.delete(id), id };
    },
  };
}

/** All four scheduling tools, ready to `registry.registerAll(...)`. */
export function createSchedulingTools(store: TaskStore, opts: SchedulingToolsOptions): ToolDefinition[] {
  return [
    createCreateScheduledTaskTool(store, opts),
    createListScheduledTasksTool(store),
    createUpdateScheduledTaskTool(store),
    createDeleteScheduledTaskTool(store),
  ];
}
