/**
 * Risk classes for tools — the intrinsic side-effect category that drives permission gating.
 * `RiskClass` itself is declared in `types.ts` (`ToolMetadata.risk`) since every tool
 * workstream declares its own risk right on the `ToolDefinition` it registers; this module
 * only adds the classification *policy* on top of that declaration.
 *
 * Ported from OpenWorker's coworker/risk.py, adapted to this codebase's shape: Python's
 * `_BASE` by-name table was the ONLY source of truth (tools carried no risk of their own,
 * just an aisuite `requires_approval` bool). Here `ToolMetadata.risk` is already a
 * first-class declared field — every tool built so far (`tools/git.ts`, `tools/search.ts`,
 * `web/fetch.ts`, …) sets it directly. So the precedence flips: a tool's own declared `risk`
 * is authoritative, and the by-name table below survives only as an un-loosenable FLOOR for
 * a fixed set of well-known dangerous names (so a mis-declared or absent-metadata write/exec
 * tool sharing one of those names can't slip out from under scoping). A user-local override
 * may relax a tool's own declaration (the intended use — quieting an over-cautious
 * MCP/plug-in tool) but may only ever TIGHTEN a floored name, never loosen it.
 */
import type { RiskClass, ToolMetadata } from "../types.js";

/** Built-in tool names whose risk is a floor, not a suggestion — mirrors OpenWorker's
 * `WRITE_TOOLS` / `SHELL_TOOL` / `EGRESS_TOOLS`. Kept as a safety net for tools that happen
 * to reuse these exact names; every tool actually shipped in this package should prefer
 * declaring `ToolMetadata.risk` directly instead of relying on being named one of these. */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write_file",
  "replace_in_file",
  "apply_patch",
  "apply_unified_diff",
]);
export const SHELL_TOOL_NAME = "run_shell";
export const EGRESS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "web_fetch",
  "web_search",
  "browser_open_url",
]);

const BASE_BY_NAME: ReadonlyMap<string, RiskClass> = new Map<string, RiskClass>([
  ...[...WRITE_TOOL_NAMES].map((name): [string, RiskClass] => [name, "write_local"]),
  [SHELL_TOOL_NAME, "exec"],
  ...[...EGRESS_TOOL_NAMES].map((name): [string, RiskClass] => [name, "egress"]),
]);

/** How much attention each class demands, for the override-tightening rule below. Higher =
 * stricter. EXEC and WRITE_LOCAL are the crown jewels (path scoping / command gating). */
const STRICTNESS: Record<RiskClass, number> = {
  read: 0,
  egress: 1,
  external: 2,
  write_local: 3,
  exec: 3,
};

/** A user-local override resolver: tool name -> RiskClass, or `undefined` to defer. */
export type RiskOverrides = (toolName: string) => RiskClass | undefined;

/**
 * Effective risk of a tool call. Precedence:
 * 1. `overrides(toolName)`, if it returns something — but only takes effect when there's no
 *    by-name floor for this tool, or the override is at least as strict as that floor
 *    (tightening is always allowed; loosening a floored name is refused and falls through).
 * 2. The by-name floor table above.
 * 3. The tool's own declared `metadata.risk`.
 * 4. `metadata.requiresApproval` → external (back-compat with tools that only set the bool).
 * 5. `"read"`.
 */
export function classify(toolName: string, metadata?: ToolMetadata, overrides?: RiskOverrides): RiskClass {
  const base = BASE_BY_NAME.get(toolName);
  if (overrides) {
    const ov = overrides(toolName);
    if (ov !== undefined && (base === undefined || STRICTNESS[ov] >= STRICTNESS[base])) {
      return ov;
    }
    // A loosening override on a floored tool is ignored: fall through.
  }
  if (base !== undefined) return base;
  if (metadata?.risk !== undefined) return metadata.risk;
  if (metadata?.requiresApproval) return "external";
  return "read";
}

/** Anything but a pure read needs the permission engine's attention. */
export function isConsequential(risk: RiskClass): boolean {
  return risk !== "read";
}
