/** Workspace-trust gate for per-project MCP config — Electron's mirror of
 * apps/server/src/workspaceTrustApi.ts. See that file's docstring for why this exists. */
import { join } from "node:path";
import { app } from "electron";
import { WorkspaceTrustStore } from "@metaharn/engine/src/trust/workspaceTrust.js";

let store: WorkspaceTrustStore | undefined;
function trustStore(): WorkspaceTrustStore {
  if (!store) store = new WorkspaceTrustStore(join(app.getPath("userData"), "workspace-trust.json"));
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
