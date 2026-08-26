/**
 * ToolRegistry — name -> callable + schema + metadata. Every workstream that adds a tool
 * (Tiers 1, 2's readonly-grant tool, MCP, automation, memory, self-wake, …) registers
 * against this one class; nothing else needs to know how many tools exist or where they
 * came from.
 *
 * Ported from OpenWorker's coworker/tools/registry.py, simplified: no aisuite metadata
 * translation layer needed since ToolDefinition already carries the shape the engine wants.
 */
import type { ToolDefinition, ToolMetadata, ToolSchema } from "../types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  metadata(name: string): ToolMetadata | undefined {
    return this.tools.get(name)?.metadata;
  }

  /** Every tool's schema, in registration order — what gets sent to the provider. */
  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((t) => t.schema);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  size(): number {
    return this.tools.size;
  }
}
