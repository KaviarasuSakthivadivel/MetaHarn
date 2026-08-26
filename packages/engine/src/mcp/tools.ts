/**
 * mcp/tools.ts — turn a server's MCP tools into registry-ready `ToolDefinition`s. TypeScript
 * sibling of OpenWorker's coworker/mcp/tools.py `build_callables`.
 *
 * Python's version wraps each MCP tool as a *sync* callable (the registry there runs
 * `execute` via `asyncio.to_thread`) that bridges back onto the server's owning task with
 * `run_coroutine_threadsafe(...).result(timeout)` — required by client.py's per-server-task
 * design (see client.ts's module docstring for why). This package's `ToolDefinition.execute`
 * is already async and this whole engine runs on one Node event loop, so there is no thread
 * to bridge across: `execute()` below just `await`s `MCPManager.call()` directly.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition, ToolSchema } from "../types.js";
import type { MCPManager } from "./client.js";
import type { MCPServerDef } from "./config.js";

// OpenAI (and most providers') function-name rule: `[A-Za-z0-9_-]{1,64}`.
const NAME_BAD = /[^a-zA-Z0-9_-]/g;
const MAX_NAME_LEN = 64;
const MAX_DESCRIPTION_LEN = 1024;

/**
 * `mcp__<server>__<tool>`, sanitized to `[A-Za-z0-9_-]` and clipped to fit the 64-char limit.
 * Mirrors tools.py's `tool_name` — note truncation means two very long, similarly-prefixed
 * names could theoretically collide; tools.py accepts the same risk and so do we.
 */
export function mcpToolName(server: string, tool: string): string {
  const base = `mcp__${server.replace(NAME_BAD, "_")}__${tool.replace(NAME_BAD, "_")}`;
  return base.length > MAX_NAME_LEN ? base.slice(0, MAX_NAME_LEN) : base;
}

/** Schema built straight from the MCP tool's own `inputSchema` — no re-derivation, for
 * fidelity to whatever the server actually declared (mirrors tools.py's `_openai_schema`). */
function toolSchema(name: string, mcpTool: Tool): ToolSchema {
  const parameters: Record<string, unknown> = mcpTool.inputSchema ?? {
    type: "object",
    properties: {},
  };
  return {
    type: "function",
    function: {
      name,
      description: (mcpTool.description ?? "").slice(0, MAX_DESCRIPTION_LEN),
      parameters,
    },
  };
}

/** `includeTools` is an allowlist when present; `excludeTools` always applies on top.
 * Mirrors tools.py's `_filtered`. */
function filterTools(tools: Tool[], server: MCPServerDef): Tool[] {
  let out = tools;
  if (server.includeTools) {
    const allow = new Set(server.includeTools);
    out = out.filter((t) => allow.has(t.name));
  }
  if (server.excludeTools?.length) {
    const block = new Set(server.excludeTools);
    out = out.filter((t) => !block.has(t.name));
  }
  return out;
}

/**
 * Flatten a `CallToolResult` into the string form that goes on the canonical tool message.
 * Mirrors client.py's `_result_payload`: text blocks join on newline; non-text blocks
 * (image/audio/resource/resource_link) describe themselves as `[type]` rather than vanish
 * silently; a structured-only result (no content blocks at all, just `structuredContent`)
 * falls back to its JSON so a tool that only returns structured output isn't reported as an
 * empty string. `isError` throws instead of returning — Engine's `executeOne` (engine.ts)
 * only records a `tool_end` error when `execute()` rejects, so a server-reported error must
 * surface as a thrown error here, not as a normal (if error-shaped) result.
 */
function flattenResult(result: CallToolResult): string {
  const parts = (result.content ?? []).map((block) =>
    block.type === "text" ? block.text : `[${block.type}]`,
  );
  const body = parts.join("\n");
  if (result.isError) throw new Error(body || "MCP tool error");
  if (!body && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return body;
}

/**
 * Shape an already-fetched tool list into `ToolDefinition`s for `server`. Pure with respect
 * to `tools` (no I/O) so a caller can rebuild a server's tools after a `tools/list_changed`
 * notification without a full reconnect — only `execute()` reaches back into `manager`, at
 * call time.
 */
export function buildMcpTools(
  manager: MCPManager,
  server: MCPServerDef,
  tools: Tool[],
): ToolDefinition[] {
  return filterTools(tools, server).map((mcpTool) => {
    const name = mcpToolName(server.name, mcpTool.name);
    const remote = mcpTool.name;
    return {
      name,
      schema: toolSchema(name, mcpTool),
      metadata: {
        category: "mcp",
        riskLevel: "medium",
        // A third-party tool's actual side effects are unknown by construction — never let
        // one default into the engine's "assumed side-effect-free" concurrent-reads bucket
        // (engine.ts's `handleToolCalls`). Mirrors risk.py's `classify()` fallback: a tool
        // with no built-in classification whose metadata carries `requires_approval` lands
        // on EXTERNAL, never READ.
        risk: "external",
        requiresApproval: server.requiresApproval,
        capabilities: [server.name],
      },
      execute: async (args, ctx) => {
        const result = await manager.call(server.name, remote, args, { signal: ctx.signal });
        return flattenResult(result);
      },
    };
  });
}

/** Convenience: ensure the connection, list its tools, and build them in one call — the
 * common case for a bootstrap that wires configured servers into a `ToolRegistry`. */
export async function loadMcpTools(
  manager: MCPManager,
  server: MCPServerDef,
): Promise<ToolDefinition[]> {
  const tools = await manager.tools(server);
  return buildMcpTools(manager, server, tools);
}
