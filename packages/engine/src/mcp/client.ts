/**
 * MCPManager — thin async MCP client over the official `@modelcontextprotocol/sdk`.
 *
 * Ported from OpenWorker's coworker/mcp/client.py, simplified: Python needs a dedicated
 * `asyncio` task per server because the SDK's transports there open/close `anyio` cancel
 * scopes that must be entered and exited on the *same* task — awaiting a tool call from a
 * different task than the one that opened the connection is unsafe there, so client.py routes
 * every call through `run_coroutine_threadsafe` into that server's owning task. Node has no
 * task-affine cancel scopes (one event loop, ordinary Promises tied to nothing but their own
 * chain), so a plain `Map<string, MCPConnection>` cache with regular async/await is
 * sufficient — no dedicated-task-per-server workaround is needed here.
 *
 * What Python's client.py has that this doesn't (deliberately, for this pass): OAuth
 * transports (mcp/oauth.py — no SecretStore/token persistence tier here yet), stderr-tail
 * capture on a crashed stdio child (crash *evidence* for a UI to show — this package has no
 * UI tier), and the explicit `verify()` health-check (a cached connection here is trusted
 * until a call on it fails). All are natural follow-ups once those tiers exist.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MCPServerDef } from "./config.js";

/** Matches client.py's `build_callables(..., timeout=120.0)` default — the ceiling on how
 * long one tool call may hang before the caller gives up on it. */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

export interface MCPConnection {
  client: Client;
  tools: Tool[];
}

export interface MCPCallOptions {
  /** Forwarded to the SDK's request layer so an engine-level interrupt (Engine's
   * `abortController`) can cancel an in-flight MCP call, not just the model stream. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class MCPManager {
  private readonly conns = new Map<string, MCPConnection>();
  /** In-flight connects, keyed by server name — collapses concurrent `ensure()` calls for
   * the same not-yet-connected server into one connection attempt instead of racing two
   * (and leaking one). Not present in client.py: Python's per-server task already serializes
   * this naturally since only one task can ever be racing to fill `_conns[name]`. */
  private readonly connecting = new Map<string, Promise<MCPConnection>>();

  /** Return a live connection for `server`, connecting (once) if needed. Propagates
   * connection errors (bad command, crashed child, unreachable url) to every caller racing
   * on the same server. */
  async ensure(server: MCPServerDef): Promise<MCPConnection> {
    const existing = this.conns.get(server.name);
    if (existing) return existing;
    let inflight = this.connecting.get(server.name);
    if (!inflight) {
      inflight = this.connect(server).finally(() => this.connecting.delete(server.name));
      this.connecting.set(server.name, inflight);
    }
    const conn = await inflight;
    this.conns.set(server.name, conn);
    return conn;
  }

  async tools(server: MCPServerDef): Promise<Tool[]> {
    return (await this.ensure(server)).tools;
  }

  /** Call a tool on an already-connected server. Throws if `name` isn't connected yet —
   * callers go through `ensure()` first (tools.ts does, at tool-build time). */
  async call(
    name: string,
    tool: string,
    args: Record<string, unknown>,
    options: MCPCallOptions = {},
  ): Promise<CallToolResult> {
    const conn = this.conns.get(name);
    if (!conn) throw new Error(`MCP server not connected: ${name}`);
    // Cast: callTool()'s declared return type also covers the experimental task-based
    // ("toolResult" wrapper) branch, which this package doesn't support yet — every server
    // this manager talks to is expected to resolve tool calls synchronously.
    const result = await conn.client.callTool({ name: tool, arguments: args }, undefined, {
      signal: options.signal,
      timeout: options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    });
    return result as unknown as CallToolResult;
  }

  /** Close every live connection. Best-effort: one server's close() failing must not stop
   * the others from closing too. */
  async aclose(): Promise<void> {
    const conns = [...this.conns.values()];
    this.conns.clear();
    this.connecting.clear();
    await Promise.allSettled(conns.map((c) => c.client.close()));
  }

  private async connect(server: MCPServerDef): Promise<MCPConnection> {
    const transport = buildTransport(server);
    const client = new Client({ name: "metaharn-engine", version: "0.1.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    return { client, tools: listed.tools };
  }
}

function buildTransport(server: MCPServerDef): Transport {
  if (server.transport === "http") {
    if (!server.url) throw new Error(`MCP server '${server.name}' is http but has no url`);
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: Object.keys(server.headers).length ? { headers: server.headers } : undefined,
    });
  }
  if (!server.command) throw new Error(`MCP server '${server.name}' is stdio but has no command`);
  return new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: server.cwd,
  });
}
