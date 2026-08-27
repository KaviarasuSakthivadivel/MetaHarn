/**
 * Workspace-trust gate for per-project MCP config — a workspace's own `.metaharn/mcp.json`
 * (see permissions/engine.ts's PROTECTED_IN_PROJECT, which already reserves `.metaharn/` as
 * workspace-level policy the agent can't self-grant) is executable provenance: a stdio entry
 * spawns a process the moment a session starts there. Cloning a repo alone must never be
 * enough to make that run — the user has to trust the workspace path first, same consent
 * boundary VS Code's "do you trust the authors of this folder" prompt exists for.
 *
 * Uses @metaharn/engine's WorkspaceTrustStore as-is (already fully self-contained); this file
 * only supplies where its state file lives.
 */
import { WorkspaceTrustStore } from "@metaharn/engine/src/trust/workspaceTrust.js";
import { statePath } from "./state.js";

let store: WorkspaceTrustStore | undefined;
function trustStore(): WorkspaceTrustStore {
  if (!store) store = new WorkspaceTrustStore(statePath("workspace-trust.json"));
  return store;
}

export function isWorkspaceTrusted(workspace: string): boolean {
  return trustStore().isTrusted(workspace);
}

export function setWorkspaceTrust(workspace: string, trusted: boolean): string {
  return trustStore().setTrusted(workspace, trusted);
}

export function listTrustedWorkspaces(): string[] {
  return trustStore().list();
}
