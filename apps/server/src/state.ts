import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** One state directory for this whole process — sessions, memory.db, audit.db, secrets.json,
 * mcp.json, automations.db all live under here. Shared by every module in this package instead
 * of each re-deriving it, so there's exactly one definition of "where does state live." */
export function stateDir(): string {
  const base =
    process.env.METAHARN_STATE_DIR ??
    (process.platform === "win32" ? join(process.env.APPDATA ?? "", "MetaHarn") : join(homedir(), ".metaharn"));
  mkdirSync(base, { recursive: true });
  return base;
}

export function statePath(...segments: string[]): string {
  return join(stateDir(), ...segments);
}
