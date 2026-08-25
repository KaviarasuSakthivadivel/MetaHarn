import os from "node:os";
import * as pty from "node-pty";
import { getAdapter } from "./agents/registry.js";
import type { AgentKind } from "./agents/types.js";

export type PtyHandle = pty.IPty;

/**
 * If MetaHarn's own process happens to be running inside a Claude Code
 * session itself (e.g. launched from a terminal that's already a Claude
 * Code child session — plausible for a dev workflow, not just a testing
 * artifact), those CLAUDE-prefixed / AI_AGENT env vars would otherwise leak
 * into whichever CLI is spawned here, regardless of which one. Claude Code
 * in particular detects that inherited marker and silently disables
 * transcript saving to avoid runaway nested sessions — which breaks
 * --session-id/--resume entirely (confirmed by reproducing it: identical
 * commands worked with these stripped, silently recorded nothing without).
 * The terminal MetaHarn gives you should always be a normal, un-nested agent
 * session regardless of what MetaHarn's own process happens to have inherited.
 */
function cleanShellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE") || key === "AI_AGENT") delete env[key];
  }
  return env;
}

/**
 * Spawns a real shell and, after a short delay, types the chosen agent
 * CLI's own launch/resume command into it — this (not launching the CLI as
 * the pty's actual process) is what lets the user drop to a normal shell
 * prompt after the CLI exits. Which exact command gets typed is entirely
 * the agent adapter's decision (see agents/*.ts) — this function doesn't
 * know or care which CLI it's launching.
 */
export function spawnPty(
  cwd: string,
  agentKind: AgentKind,
  catalogSessionId: string,
  externalSessionId: string | null,
  seedPrompt?: string,
): PtyHandle {
  const shell = process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "/bin/zsh");
  const term = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env: cleanShellEnv(),
  });

  const command = getAdapter(agentKind).buildLaunchCommand({ cwd, catalogSessionId, externalSessionId, seedPrompt });
  setTimeout(() => term.write(`${command}\r`), 300);

  return term;
}
