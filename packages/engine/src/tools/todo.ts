/**
 * Todo / plan tool — a structured task list the agent maintains and the UI renders.
 *
 * Most of the "organized agent" feel in interactive work. Low risk, auto-approved. The list
 * is held in a `TodoList` the surface can read; `todo_write` replaces it wholesale each call.
 *
 * Ported from OpenWorker's coworker/tools/todo.py.
 */
import type { ToolDefinition, ToolSchema } from "../types.js";

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const TODO_STATUSES: ReadonlySet<string> = new Set<TodoStatus>(["pending", "in_progress", "done"]);

/** Plain mutable holder the hosting surface (chat UI, CLI renderer, …) reads from directly —
 * `todo_write`'s execute() replaces `.items` wholesale each call, same as the Python dataclass. */
export class TodoList {
  items: TodoItem[] = [];
}

// Explicit schema — the array-of-objects shape can't be reliably auto-generated, and
// providers reject a bare "array" annotation with no item shape. Registered directly on
// the ToolDefinition rather than derived.
//
// The parameter is `todos`, NOT `items`: a top-level argument key named "items" shadows
// minijinja's `.items()` map method in at least one hosted chat template (Together's
// GLM-5.2, 2026-07-21 — "object is not callable"), 400-ing every request that replays the
// call. Any key name that isn't a minijinja map method is safe; never rename back.
const TODO_WRITE_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "todo_write",
    description: "Replace the task list. Provide the full list of todos each call.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
};

/** `todos` argument entries coming from a model are loosely typed at best — normalize each
 * into a well-formed TodoItem rather than trusting the shape. */
function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const normalized: TodoItem[] = [];
  for (const entry of raw) {
    if (entry !== null && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      let status = typeof record.status === "string" ? record.status : "pending";
      if (status === "completed") status = "done"; // common model alias for our "done"
      normalized.push({
        content: typeof record.content === "string" ? record.content : String(record.content ?? ""),
        status: TODO_STATUSES.has(status) ? (status as TodoStatus) : "pending",
      });
    } else {
      normalized.push({ content: String(entry), status: "pending" });
    }
  }
  return normalized;
}

export function createTodoWriteTool(todo: TodoList): ToolDefinition {
  return {
    name: "todo_write",
    schema: TODO_WRITE_SCHEMA,
    metadata: { category: "planning", riskLevel: "low", risk: "read", requiresApproval: false, capabilities: ["todo"] },
    execute: async (args) => {
      // `items` stays accepted too — models that free-style the old param name, or a queued
      // replay recorded before the rename above, must not suddenly start failing.
      const raw = args.todos !== undefined ? args.todos : args.items;
      const normalized = normalizeTodos(raw);
      todo.items = normalized;
      return { count: normalized.length, todos: normalized };
    },
  };
}
