/** Settings > MCP for the owned-engine backend — Electron's mirror of apps/server/src/mcpApi.ts,
 * pointed at the SAME mcp.json ownedEngine.ts's sessions read (app.getPath("userData")/mcp.json). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { loadMcpServers, type MCPServerDef } from "@metaharn/engine/src/mcp/config.js";
import { MCPManager } from "@metaharn/engine/src/mcp/client.js";

function configPath(): string {
  return join(app.getPath("userData"), "mcp.json");
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

/** Live connectivity test — a throwaway MCPManager connects, lists tools, and closes again.
 * Mirrors apps/server/src/mcpApi.ts's testMcpServer(). */
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
