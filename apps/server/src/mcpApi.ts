/** Settings > MCP: view/add/edit/remove entries in this state dir's global mcp.json — the
 * same file @metaharn/engine's loadMcpServers() reads when a session starts. Works on the raw
 * `{"mcpServers": {...}}` JSON directly (not just the parsed MCPServerDef view) so editing one
 * server never drops fields this UI doesn't know about. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadMcpServers, type MCPServerDef } from "@metaharn/engine/src/mcp/config.js";
import { MCPManager } from "@metaharn/engine/src/mcp/client.js";
import { statePath } from "./state.js";

function configPath(): string {
  return statePath("mcp.json");
}

function readRaw(): { mcpServers: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as { mcpServers?: Record<string, unknown> };
    return { mcpServers: parsed.mcpServers ?? {} };
  } catch {
    return { mcpServers: {} };
  }
}

function writeRaw(data: { mcpServers: Record<string, unknown> }): void {
  writeFileSync(configPath(), JSON.stringify(data, null, 2));
}

export function listMcpServers(): MCPServerDef[] {
  if (!existsSync(configPath())) return [];
  return loadMcpServers({ global: configPath() });
}

export interface McpServerInput {
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export function putMcpServer(name: string, input: McpServerInput): void {
  const data = readRaw();
  const existing = (data.mcpServers[name] as Record<string, unknown>) ?? {};
  data.mcpServers[name] = {
    ...existing,
    ...(input.transport === "http" ? { type: "http" } : {}),
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.args !== undefined ? { args: input.args } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.headers !== undefined ? { headers: input.headers } : {}),
    enabled: input.enabled ?? existing.enabled ?? true,
  };
  writeRaw(data);
}

export function deleteMcpServer(name: string): boolean {
  const data = readRaw();
  if (!(name in data.mcpServers)) return false;
  delete data.mcpServers[name];
  writeRaw(data);
  return true;
}

export interface McpTestResult {
  ok: boolean;
  toolCount?: number;
  tools?: string[];
  error?: string;
}

/** Live connectivity test — a throwaway MCPManager (never the one a real session's registry
 * uses) connects, lists tools, and closes again. This is what "Add & test" actually does: it
 * never just saves a config and hopes, it proves the server responds before reporting success. */
export interface McpTestCandidate {
  transport: "stdio" | "http";
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  requiresApproval?: boolean;
}

export async function testMcpServer(candidate: McpTestCandidate): Promise<McpTestResult> {
  const manager = new MCPManager();
  const server: MCPServerDef = {
    name: candidate.name ?? "__test__",
    transport: candidate.transport,
    command: candidate.command,
    args: candidate.args ?? [],
    env: candidate.env ?? {},
    cwd: candidate.cwd,
    url: candidate.url,
    headers: candidate.headers ?? {},
    enabled: true,
    requiresApproval: candidate.requiresApproval ?? true,
  };
  try {
    const conn = await manager.ensure(server);
    return { ok: true, toolCount: conn.tools.length, tools: conn.tools.map((t) => t.name) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await manager.aclose();
  }
}
