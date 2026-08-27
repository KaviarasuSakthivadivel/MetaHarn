// Tool calls render as English one-liners in the transcript instead of a bare tool name — the
// model doesn't emit a purpose per call (the stream is name+args+result), so the sentence is
// synthesized here from per-tool templates. Mirrors OpenWorker's own humanize.ts (same tool
// names, since @metaharn/engine's tool set overlaps it closely) so both surfaces read the same
// way; falls back to "Used <tool> — <short args>" for anything not templated below, including
// MCP tools (mcp__<server>__<tool>, unpacked into "<tool> (via <server>)").

export interface HumanLine {
  pre: string;
  obj?: string;
  post?: string;
}

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const baseName = (p: string) => p.replace(/\/+$/, "").split(/[\\/]/).pop() || p;

export function shortArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => {
      let s = typeof v === "string" ? v : JSON.stringify(v);
      if (s.length > 96) s = s.slice(0, 95) + "...";
      return `${k}=${s.replace(/\n/g, " ")}`;
    })
    .join("  ");
}

function mcpParts(name: string): { server: string; tool: string } | null {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : null;
}

export function humanizeTool(name: string, args: unknown): HumanLine {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "run_shell": {
      const cmd = trunc(String(a.command ?? ""), 60);
      const desc = typeof a.description === "string" && a.description.trim() ? a.description.trim() : "";
      return {
        pre: "Ran ",
        obj: cmd,
        ...(desc ? { post: ` — ${desc.charAt(0).toLowerCase()}${desc.slice(1)}` } : {}),
      };
    }
    case "read_file":
      return { pre: "Read ", obj: baseName(String(a.path ?? "a file")) };
    case "write_file":
      return { pre: "Wrote ", obj: baseName(String(a.path ?? "a file")) };
    case "replace_in_file":
      return { pre: "Edited ", obj: a.path ? baseName(String(a.path)) : "a file" };
    case "grep":
      return { pre: "Searched the code for ", obj: `“${trunc(String(a.pattern ?? ""), 40)}”` };
    case "git_log":
      return { pre: "Looked through recent git history" };
    case "todo_write": {
      const items = Array.isArray(a.todos) ? (a.todos as Array<Record<string, unknown>>) : [];
      if (items.length === 1) {
        const it = items[0] || {};
        const status = String(it.status || "").replace(/_/g, " ");
        return {
          pre: "Updated the plan — ",
          obj: `“${trunc(String(it.content ?? ""), 70)}”`,
          ...(status ? { post: ` → ${status}` } : {}),
        };
      }
      return { pre: `Updated the plan — ${items.length} item${items.length === 1 ? "" : "s"}` };
    }
    case "web_search":
      return { pre: "Searched the web — ", obj: `“${trunc(String(a.query ?? ""), 60)}”` };
    case "web_fetch": {
      let host = String(a.url ?? "");
      try {
        host = new URL(host).host || host;
      } catch {
        /* keep raw */
      }
      return { pre: "Read a web page — ", obj: trunc(host, 50) };
    }
    case "explore":
      return { pre: "Sent a sub-agent to explore — ", obj: `“${trunc(String(a.task ?? a.prompt ?? ""), 60)}”` };
    case "ask_user":
      return { pre: "Asked you a question" };
    case "propose_plan":
      return { pre: "Proposed a plan" };
    case "request_directory":
      return { pre: "Asked for folder access", ...(a.path ? { post: ` — ${String(a.path)}` } : {}) };
    case "remember":
      return { pre: "Saved a memory — ", obj: `“${trunc(String(a.content ?? ""), 60)}”` };
    case "memory_read":
      return { pre: "Looked up memories" };
    case "memory_update":
      return { pre: "Updated a memory" };
    case "memory_forget":
      return { pre: "Forgot a memory" };
    case "create_scheduled_task":
      return a.title ? { pre: "Created the automation ", obj: `“${trunc(String(a.title), 60)}”` } : { pre: "Created an automation" };
    case "update_scheduled_task":
      return { pre: "Updated an automation" };
    case "delete_scheduled_task":
      return { pre: "Deleted an automation" };
    case "list_scheduled_tasks":
      return { pre: "Listed automations" };
    default: {
      const mcp = mcpParts(name);
      if (mcp) {
        const rest = trunc(shortArgs(a), 70);
        return { pre: "Used ", obj: `${mcp.tool} (via ${mcp.server})`, ...(rest ? { post: ` — ${rest}` } : {}) };
      }
      const rest = trunc(shortArgs(a), 80);
      return { pre: `Used ${name}`, ...(rest ? { post: ` — ${rest}` } : {}) };
    }
  }
}
