import { existsSync, statSync } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ApprovalOutcome } from "@metaharn/engine";
import { createMetaHarnSession, getModelConfig, type MetaHarnSession } from "./agent.js";
import { createOwnedEngineSession, ownedEngineEnabled, type OwnedEngineSession } from "./ownedEngine.js";
import { closePty, setPendingSeedPrompt } from "./pty-ipc.js";
import { generateHandoffSummary } from "./agents/handoff.js";
import { getTerminalSessionStats } from "./terminal-stats.js";
import { detectInstalledAgents, getAdapter, resolveExternalSessionId } from "./agents/registry.js";
import { getAllAgentStatuses, installAgent, uninstallAgent, upgradeAgent } from "./agents/lifecycle.js";
import type { AgentKind } from "./agents/types.js";
import {
  archiveProject,
  archiveSession,
  createTerminalSession,
  deleteTerminalSession,
  deleteWorktreeCatalogRows,
  ensureOrgAndRepo,
  getProjectDeletionPreview,
  getRepoById,
  getRepoByLocalPath,
  getSessionById,
  getSessionCwd,
  getSessionDependencies,
  getSessionIdsByRepoId,
  getWorktreeLinks,
  getWorktreeParentCwd,
  listArchivedRepos,
  listRepos,
  listWorktreeRepoIds,
  recordSession,
  recordWorktree,
  removeProject,
  removeSessionDependency,
  renameTerminalSession,
  setExternalSessionId,
  setSessionDependency,
  swapTerminalSessionAgent,
  unarchiveProject,
  unarchiveSession,
} from "./catalog.js";
import { deleteSession, listAllSessions, listArchivedSessions, messagesToHistory, treeToDTO } from "./sessions.js";
import { listDirectoryTree, readProjectFile, writeProjectFile } from "./files.js";
import {
  checkoutBranch,
  createBranch,
  deleteBranch,
  getCommitFileList,
  getCommitMeta,
  getCurrentBranch,
  getFileDiffContent,
  getGitBranches,
  getGitBranchesDetailed,
  getGitChanges,
  getGitLog,
  getGitRemoteBranches,
  getGitStatus,
  getWorkingFileDiff,
  removeWorktree,
} from "./git.js";
import { createWorktree } from "./worktree.js";

// Two backends share one window slot: "pi" is the original, embedded-SDK path
// (createMetaHarnSession); "owned" is MetaHarn's own engine (ownedEngine.ts), selected via
// METAHARN_CHAT_ENGINE=owned — see docs/research/openworker-integration.md. Kept as a
// discriminated union rather than a unifying interface so every existing Pi call site below
// stays byte-for-byte unchanged; only the owned branch is new.
type WindowSession =
  | { kind: "pi"; session: MetaHarnSession; sessionManager: SessionManager; unsubscribe: () => void }
  | { kind: "owned"; session: OwnedEngineSession; unsubscribe: () => void };

// Keyed by webContents.id — one chat session per window, mirroring the old
// one-session-per-WebSocket-connection model.
const sessionsByWindow = new Map<number, WindowSession>();

function pushEvent(sender: WebContents, payload: unknown) {
  if (!sender.isDestroyed()) sender.send("metaharn:event", payload);
}

async function runTurn(sender: WebContents, run: (session: MetaHarnSession | OwnedEngineSession) => Promise<void>) {
  const entry = sessionsByWindow.get(sender.id);
  if (!entry) {
    pushEvent(sender, { type: "error", message: "Send an init message before prompting" });
    return;
  }
  await run(entry.session);
  // Both backends can finish a turn without throwing (e.g. a provider-level rejection like
  // insufficient credits) and carry that as a side channel instead — Pi via
  // session.agent.state, the owned engine via its own errorMessage field — so each needs its
  // own forwarding path rather than relying on the catch block below.
  if (entry.kind === "pi") {
    if (entry.session.agent.state.errorMessage) {
      pushEvent(sender, { type: "error", message: entry.session.agent.state.errorMessage });
    }
  } else if (entry.session.errorMessage) {
    pushEvent(sender, { type: "error", message: entry.session.errorMessage });
  }
}

export function disposeSessionFor(webContentsId: number) {
  const entry = sessionsByWindow.get(webContentsId);
  if (!entry) return;
  entry.unsubscribe();
  entry.session.dispose();
  sessionsByWindow.delete(webContentsId);
}

export function registerIpcHandlers() {
  ipcMain.handle("metaharn:listSessions", async () => {
    try {
      return await listAllSessions();
    } catch (err) {
      console.warn("[metaharn] listSessions failed:", (err as Error).message);
      return [];
    }
  });

  ipcMain.handle(
    "metaharn:init",
    async (event: IpcMainInvokeEvent, repoPath: string, resumeSessionPath?: string) => {
      const sender = event.sender;
      try {
        if (!repoPath || !existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
          pushEvent(sender, { type: "error", message: `Not a directory: ${repoPath}` });
          return;
        }

        disposeSessionFor(sender.id);

        if (ownedEngineEnabled()) {
          // No durable transcript yet for this backend (see ownedEngine.ts's module doc) —
          // resumeSessionPath is accepted but ignored; every owned-engine session starts
          // fresh. A real resume story is deliberate later work, not an oversight.
          const session = createOwnedEngineSession(repoPath);
          const unsubscribe = session.subscribe((e) => pushEvent(sender, e));
          sessionsByWindow.set(sender.id, { kind: "owned", session, unsubscribe });

          const { org, repo } = await ensureOrgAndRepo(repoPath);
          recordSession(session.sessionId, org.id, repo.id).catch((err) =>
            console.warn("[metaharn] catalog write failed:", (err as Error).message),
          );

          pushEvent(sender, { type: "ready", sessionId: session.sessionId, history: [] });
          return;
        }

        const { session, sessionManager, orgId, repoId } = await createMetaHarnSession(repoPath, {
          resumeSessionPath,
        });

        const unsubscribe = session.subscribe((e) => {
          switch (e.type) {
            case "message_update":
              if (e.assistantMessageEvent.type === "text_delta") {
                pushEvent(sender, { type: "text_delta", delta: e.assistantMessageEvent.delta });
              } else if (e.assistantMessageEvent.type === "thinking_delta") {
                pushEvent(sender, { type: "thinking_delta", delta: e.assistantMessageEvent.delta });
              }
              break;
            case "tool_execution_start":
              pushEvent(sender, { type: "tool_start", toolCallId: e.toolCallId, toolName: e.toolName, args: e.args });
              break;
            case "tool_execution_end":
              pushEvent(sender, {
                type: "tool_end",
                toolCallId: e.toolCallId,
                toolName: e.toolName,
                result: e.result,
                isError: e.isError,
              });
              break;
            case "agent_end":
              pushEvent(sender, { type: "agent_end" });
              break;
          }
        });

        sessionsByWindow.set(sender.id, { kind: "pi", session, sessionManager, unsubscribe });

        recordSession(session.sessionId, orgId, repoId).catch((err) =>
          console.warn("[metaharn] catalog write failed:", (err as Error).message),
        );

        pushEvent(sender, {
          type: "ready",
          sessionId: session.sessionId,
          history: resumeSessionPath ? messagesToHistory(session.messages) : [],
        });
      } catch (err) {
        pushEvent(sender, { type: "error", message: (err as Error).message });
      }
    },
  );

  ipcMain.handle("metaharn:prompt", async (event: IpcMainInvokeEvent, text: string) => {
    try {
      await runTurn(event.sender, (s) => s.prompt(String(text ?? "")));
    } catch (err) {
      pushEvent(event.sender, { type: "error", message: (err as Error).message });
    }
  });

  ipcMain.handle("metaharn:steer", async (event: IpcMainInvokeEvent, text: string) => {
    try {
      await runTurn(event.sender, (s) => s.steer(String(text ?? "")));
    } catch (err) {
      pushEvent(event.sender, { type: "error", message: (err as Error).message });
    }
  });

  ipcMain.handle("metaharn:followUp", async (event: IpcMainInvokeEvent, text: string) => {
    try {
      await runTurn(event.sender, (s) => s.followUp(String(text ?? "")));
    } catch (err) {
      pushEvent(event.sender, { type: "error", message: (err as Error).message });
    }
  });

  ipcMain.handle("metaharn:fsListTree", (_event, root: string) => listDirectoryTree(root));

  ipcMain.handle("metaharn:fsReadFile", (_event, root: string, relPath: string) =>
    readProjectFile(root, relPath),
  );

  ipcMain.handle("metaharn:fsWriteFile", (_event, root: string, relPath: string, content: string) =>
    writeProjectFile(root, relPath, content),
  );

  ipcMain.handle("metaharn:getGitBranch", (_event, cwd: string) => getCurrentBranch(cwd));
  ipcMain.handle("metaharn:getGitStatus", (_event, cwd: string) => getGitStatus(cwd));
  ipcMain.handle("metaharn:getGitChanges", (_event, cwd: string) => getGitChanges(cwd));
  ipcMain.handle("metaharn:getGitLog", (_event, cwd: string, skip: number, limit: number, branch?: string) =>
    getGitLog(cwd, skip, limit, branch),
  );
  ipcMain.handle("metaharn:getGitBranches", (_event, cwd: string) => getGitBranches(cwd));
  ipcMain.handle("metaharn:getGitBranchesDetailed", (_event, cwd: string) => getGitBranchesDetailed(cwd));
  ipcMain.handle("metaharn:getGitRemoteBranches", (_event, cwd: string) => getGitRemoteBranches(cwd));
  ipcMain.handle("metaharn:getCommitMeta", (_event, cwd: string, hash: string) => getCommitMeta(cwd, hash));
  ipcMain.handle("metaharn:getCommitFileList", (_event, cwd: string, hash: string) => getCommitFileList(cwd, hash));
  ipcMain.handle("metaharn:getFileDiffContent", (_event, cwd: string, hash: string, path: string) =>
    getFileDiffContent(cwd, hash, path),
  );
  ipcMain.handle("metaharn:getWorkingFileDiff", (_event, cwd: string, path: string) => getWorkingFileDiff(cwd, path));

  // Never forced — see git.ts's checkoutBranch doc comment. A real failure
  // (uncommitted changes in the way) propagates to the renderer, which
  // alert()s it, this codebase's existing convention for a failed mutation.
  ipcMain.handle("metaharn:checkoutBranch", (_event, cwd: string, branch: string) => checkoutBranch(cwd, branch));
  ipcMain.handle("metaharn:createBranch", (_event, cwd: string, name: string) => createBranch(cwd, name));
  ipcMain.handle("metaharn:deleteBranch", (_event, cwd: string, name: string, force: boolean) =>
    deleteBranch(cwd, name, force),
  );

  ipcMain.handle("metaharn:registerProject", async (_event, cwd: string) => {
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`Not a directory: ${cwd}`);
    }
    const { repo } = await ensureOrgAndRepo(cwd);
    return { id: repo.id, name: repo.name, localPath: repo.localPath };
  });

  // Worktree checkouts (project_worktrees, see schema.ts) are real repos
  // rows but not projects in their own right — excluded here so they don't
  // show up as a separate top-level entry; Sidebar.tsx merges their
  // sessions into their parent's card list instead (via metaharn:getWorktreeLinks).
  ipcMain.handle("metaharn:listProjects", async () => {
    try {
      const [repoRows, worktreeIds] = await Promise.all([listRepos(), listWorktreeRepoIds()]);
      return repoRows
        .filter((r) => !worktreeIds.has(r.id))
        .map((r) => ({ id: r.id, name: r.name, localPath: r.localPath }));
    } catch (err) {
      console.warn("[metaharn] listProjects failed:", (err as Error).message);
      return [];
    }
  });

  ipcMain.handle("metaharn:getAppInfo", () => ({ version: app.getVersion(), ...getModelConfig() }));

  ipcMain.handle("metaharn:deleteSession", (_event, sessionPath: string) => deleteSession(sessionPath));

  ipcMain.handle("metaharn:createTerminalSession", async (_event, cwd: string, agentKind: AgentKind, seedPrompt?: string) => {
    // seedPrompt comes from the home-page launcher (HomePage.tsx) — the
    // typed goal becomes both the new session's title and, via the same
    // one-shot mechanism the agent-swap handoff uses (setPendingSeedPrompt,
    // consumed by the next metaharn:ptyCreate for this id), the CLI's actual
    // initial launch prompt — not simulated keystrokes.
    const title = seedPrompt ? (seedPrompt.length > 60 ? `${seedPrompt.slice(0, 60)}...` : seedPrompt) : undefined;
    const result = await createTerminalSession(cwd, agentKind, title);
    if (seedPrompt) setPendingSeedPrompt(result.id, seedPrompt);
    return result;
  });

  ipcMain.handle("metaharn:deleteTerminalSession", (_event, id: string) => {
    closePty(id); // a session being deleted shouldn't leave an orphaned live process behind
    return deleteTerminalSession(id);
  });

  ipcMain.handle("metaharn:renameTerminalSession", (_event, id: string, title: string) =>
    renameTerminalSession(id, title),
  );

  // Real `git worktree` — a second, independent checkout + branch, as a
  // sibling directory of the parent session's cwd. The checkout still gets
  // its own repos row (a different cwd needs one — see schema.ts's
  // projectWorktrees doc comment) but recordWorktree links it to the
  // parent's repo so it's excluded from the top-level project list and
  // shows up merged into the parent's Sidebar group instead. Does NOT
  // create the child session itself: chat vs. terminal creation are
  // different async flows on the renderer side, so the renderer creates the
  // actual session once it has this path, then calls
  // metaharn:setSessionDependency itself.
  ipcMain.handle("metaharn:createWorktreeSession", async (_event, parentSessionId: string) => {
    const parentCwd = await getSessionCwd(parentSessionId);
    if (!parentCwd) throw new Error("Parent session not found");
    const parent = await getSessionById(parentSessionId);
    const { worktreePath, branch } = createWorktree(parentCwd);
    const { repo: childRepo } = await ensureOrgAndRepo(worktreePath);
    if (parent?.repoId) await recordWorktree(childRepo.id, parent.repoId, branch);
    return { worktreePath, parentType: parent?.type as "chat" | "terminal", parentAgentKind: parent?.agentKind as AgentKind };
  });

  // Same real `git worktree` mechanism as metaharn:createWorktreeSession, but
  // entered from a project directly (ProjectOverview.tsx's WORKTREES "+ New"
  // card) rather than from an existing session — cwd is already known, so
  // there's no parent session id to resolve it from.
  ipcMain.handle("metaharn:createWorktreeFromProject", async (_event, cwd: string) => {
    const { repo: parentRepo } = await ensureOrgAndRepo(cwd);
    const { worktreePath, branch } = createWorktree(cwd);
    const { repo: childRepo } = await ensureOrgAndRepo(worktreePath);
    await recordWorktree(childRepo.id, parentRepo.id, branch);
    return { worktreePath, branch };
  });

  // Visual-only minimap annotation — see schema.ts's sessionDependencies doc
  // comment. Never touches git.
  ipcMain.handle("metaharn:setSessionDependency", (_event, sessionId: string, dependsOnSessionId: string) =>
    setSessionDependency(sessionId, dependsOnSessionId),
  );
  ipcMain.handle("metaharn:removeSessionDependency", (_event, sessionId: string, dependsOnSessionId: string) =>
    removeSessionDependency(sessionId, dependsOnSessionId),
  );
  ipcMain.handle("metaharn:getSessionDependencies", () => getSessionDependencies());
  ipcMain.handle("metaharn:getWorktreeLinks", () => getWorktreeLinks());

  // Real removal: `git worktree remove --force` (never blocked by dirty
  // state — the renderer already showed the real uncommitted-changes list
  // via metaharn:getGitChanges before ever calling this, see
  // ProjectOverview.tsx), THEN the catalog cleanup — in that order, so a
  // failed git removal (bad path, locked worktree) never leaves the DB out
  // of sync with what's actually still on disk.
  ipcMain.handle("metaharn:removeWorktreeSession", async (_event, worktreePath: string) => {
    const repo = await getRepoByLocalPath(worktreePath);
    if (!repo) throw new Error("Worktree not found in catalog");
    const parentCwd = await getWorktreeParentCwd(repo.id);
    if (!parentCwd) throw new Error("Not a linked worktree");
    removeWorktree(parentCwd, worktreePath);
    const sessionIds = await getSessionIdsByRepoId(repo.id);
    for (const id of sessionIds) closePty(id);
    await deleteWorktreeCatalogRows(repo.id);
  });

  // Swaps which agent a terminal session runs, in place (the header's
  // `{agent} ⌄` dropdown). Closing the live pty first is required, not optional — pty-ipc.ts's
  // attach-or-create logic would otherwise just hand back the OLD agent's
  // still-running process on the next metaharn:ptyCreate call.
  //
  // Before any of that: ask the OUTGOING agent (if it has a resumable
  // session) to summarize itself for a handoff — see agents/handoff.ts.
  // Never blocks the swap on failure; generateHandoffSummary already
  // degrades to null for any reason (unsupported adapter, nothing
  // resumable, timeout, CLI error).
  ipcMain.handle("metaharn:swapTerminalSessionAgent", async (_event, id: string, cwd: string, agentKind: AgentKind) => {
    const source = await getSessionById(id);
    const sourceExternalId = source
      ? resolveExternalSessionId({ agentKind: source.agentKind as AgentKind, id: source.id, externalSessionId: source.externalSessionId })
      : null;
    const summary = source ? await generateHandoffSummary(cwd, source.agentKind as AgentKind, sourceExternalId) : null;

    closePty(id);
    await swapTerminalSessionAgent(id, agentKind);
    if (summary) setPendingSeedPrompt(id, summary);
    return { ok: true, handedOffContext: summary !== null };
  });

  ipcMain.handle("metaharn:listAvailableAgents", () =>
    detectInstalledAgents().map((kind) => ({ kind, displayName: getAdapter(kind).displayName })),
  );

  // Settings page's agent-CLI manager (install/uninstall/upgrade) — see
  // agents/lifecycle.ts. All three real npm-exec calls, bounded by a
  // timeout there; never a shell string, always argv, even though every
  // input here is an internally-fixed package/binary name, not user input.
  ipcMain.handle("metaharn:getAgentStatuses", () => getAllAgentStatuses());
  ipcMain.handle("metaharn:installAgent", (_event, kind: AgentKind) => installAgent(kind));
  ipcMain.handle("metaharn:uninstallAgent", (_event, kind: AgentKind) => uninstallAgent(kind));
  ipcMain.handle("metaharn:upgradeAgent", (_event, kind: AgentKind) => upgradeAgent(kind));

  /** Resolves a terminal session's real external id, retrying discovery
   * on-demand for adapters that couldn't be told their id upfront (Codex)
   * if pty-ipc.ts's background poll hasn't found it yet — e.g. a slow
   * typist opening the context panel well after the poll window lapsed. */
  async function resolveOrDiscoverExternalId(
    cwd: string,
    session: { agentKind: string; id: string; externalSessionId: string | null; createdAt: Date },
  ): Promise<string | null> {
    const agentKind = session.agentKind as AgentKind;
    const existing = resolveExternalSessionId({ agentKind, id: session.id, externalSessionId: session.externalSessionId });
    if (existing) return existing;
    const adapter = getAdapter(agentKind);
    if (!adapter.discoverExternalSessionId) return null;
    const found = await adapter.discoverExternalSessionId({ cwd, sinceMs: session.createdAt.getTime() });
    if (found) await setExternalSessionId(session.id, found);
    return found;
  }

  ipcMain.handle(
    "metaharn:forkTerminalSession",
    async (_event, cwd: string, sourceId: string, sourceTitle: string | undefined) => {
      const source = await getSessionById(sourceId);
      if (!source) return { id: undefined, hasHistory: false };
      const sourceExternalId = await resolveOrDiscoverExternalId(cwd, source);
      if (!sourceExternalId) return { id: undefined, hasHistory: false };

      const agentKind = source.agentKind as AgentKind;
      const { id } = await createTerminalSession(cwd, agentKind, sourceTitle ? `${sourceTitle} (fork)` : "Forked session");
      const result = getAdapter(agentKind).forkSession(cwd, sourceExternalId, id);
      if (!result.ok) {
        // Nothing forkable — the row would be indistinguishable from a
        // fresh session anyway, so don't leave an orphaned entry behind.
        await deleteTerminalSession(id);
        return { id, hasHistory: false, reason: result.reason };
      }
      await setExternalSessionId(id, result.externalId);
      return { id, hasHistory: true };
    },
  );

  ipcMain.handle("metaharn:getTerminalSessionStats", async (_event, cwd: string, sessionId: string) => {
    const session = await getSessionById(sessionId);
    if (!session) return null;
    const externalId = await resolveOrDiscoverExternalId(cwd, session);
    return getTerminalSessionStats(cwd, session.agentKind as AgentKind, externalId);
  });

  // Real cascade, not just catalog rows — a project can have its own live
  // sessions AND real `git worktree` checkouts hanging off it (see
  // project_worktrees), and neither was ever cleaned up here before this:
  // ptys were left running and worktree directories/branches were
  // orphaned on disk forever. Mirrors metaharn:removeWorktreeSession's own
  // "real git/pty side-effects first, catalog rows last" ordering, just
  // looped over every linked worktree before touching the project's own
  // rows — a failed removeWorktree() partway through intentionally throws
  // and aborts the whole handler rather than leaving a half-cleaned state
  // (the renderer already showed the real preview via
  // metaharn:getProjectDeletionPreview before ever calling this).
  ipcMain.handle("metaharn:removeProject", async (_event, repoId: string) => {
    const repo = await getRepoById(repoId);
    if (!repo) throw new Error("Project not found");

    const preview = await getProjectDeletionPreview(repoId);
    for (const worktree of preview.worktrees) {
      const worktreeRepo = await getRepoByLocalPath(worktree.cwd);
      if (!worktreeRepo) continue; // shouldn't happen — link row pointed at a repo that's already gone
      removeWorktree(repo.localPath, worktree.cwd);
      const sessionIds = await getSessionIdsByRepoId(worktreeRepo.id);
      for (const id of sessionIds) closePty(id);
      await deleteWorktreeCatalogRows(worktreeRepo.id);
    }

    const ownSessionIds = await getSessionIdsByRepoId(repoId);
    for (const id of ownSessionIds) closePty(id);
    await removeProject(repoId);
  });

  ipcMain.handle("metaharn:getProjectDeletionPreview", (_event, repoId: string) => getProjectDeletionPreview(repoId));
  ipcMain.handle("metaharn:archiveProject", (_event, repoId: string) => archiveProject(repoId));
  ipcMain.handle("metaharn:unarchiveProject", (_event, repoId: string) => unarchiveProject(repoId));
  ipcMain.handle("metaharn:listArchivedProjects", async () =>
    (await listArchivedRepos()).map((r) => ({ id: r.id, name: r.name, localPath: r.localPath })),
  );

  // Session-level mirror of the archive-project trio above — purely a
  // visibility flag (see catalog.ts's archiveSession doc comment), never
  // touches the real JSONL file or a live pty. Permanent deletion stays on
  // metaharn:deleteSession/metaharn:deleteTerminalSession, unchanged.
  ipcMain.handle("metaharn:archiveSession", (_event, id: string) => archiveSession(id));
  ipcMain.handle("metaharn:unarchiveSession", (_event, id: string) => unarchiveSession(id));
  ipcMain.handle("metaharn:listArchivedSessions", (_event, cwd?: string) => listArchivedSessions(cwd));

  ipcMain.handle("metaharn:abort", async (event: IpcMainInvokeEvent) => {
    await sessionsByWindow.get(event.sender.id)?.session.abort();
  });

  // Owned-engine only — resolves a PERMISSION_REQUIRED prompt the renderer showed. A no-op
  // for a Pi-backed session, or if the id doesn't match a still-pending approval (e.g. the
  // window was closed and reopened after a permission prompt was already answered/dropped).
  ipcMain.handle(
    "metaharn:resolvePermission",
    (event: IpcMainInvokeEvent, toolCallId: string, outcome: ApprovalOutcome) => {
      const entry = sessionsByWindow.get(event.sender.id);
      if (entry?.kind === "owned") entry.session.resolvePermission(toolCallId, outcome);
    },
  );

  ipcMain.handle("metaharn:pickDirectory", async (event: IpcMainInvokeEvent) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("metaharn:getSessionTree", (event: IpcMainInvokeEvent) => {
    const entry = sessionsByWindow.get(event.sender.id);
    // No session-tree concept for the owned engine yet (no persistence at all in this pass —
    // see ownedEngine.ts) — an empty tree, not an error, matches how the renderer already
    // treats "nothing to show here" for other panels.
    if (!entry || entry.kind !== "pi") return [];
    // Pure read of the manager's tree structure — safe to call directly,
    // unlike branching (see below), which goes through AgentSession instead.
    return treeToDTO(entry.sessionManager.getTree());
  });

  ipcMain.handle("metaharn:branchSession", async (event: IpcMainInvokeEvent, entryId: string) => {
    const sender = event.sender;
    const entry = sessionsByWindow.get(sender.id);
    if (!entry || entry.kind !== "pi") return;
    try {
      // Goes through AgentSession.navigateTree() rather than calling
      // sessionManager.branch() directly — the manager's leaf pointer isn't
      // the only state AgentSession tracks, and navigateTree is Pi's own
      // "move here and keep everything else consistent" entry point (same
      // one their /tree command uses internally).
      await entry.session.navigateTree(entryId);
      pushEvent(sender, {
        type: "ready",
        sessionId: entry.session.sessionId,
        history: messagesToHistory(entry.session.messages),
      });
    } catch (err) {
      pushEvent(sender, { type: "error", message: (err as Error).message });
    }
  });

  ipcMain.handle("metaharn:getSessionStats", (event: IpcMainInvokeEvent) => {
    const entry = sessionsByWindow.get(event.sender.id);
    // No SessionStats equivalent for the owned engine yet (no token-usage accounting wired
    // up in this pass) — ContextWindowPanel already renders `null` as "—", the same
    // treatment a session with no stats yet gets today.
    if (!entry || entry.kind !== "pi") return null;
    // getSessionStats() aggregates over ALL entries including compacted-away
    // history (token/cost totals reflect what was actually billed), and its
    // contextUsage field is specifically the *latest turn's* context size —
    // the two numbers answer different questions, both shown in the panel.
    return entry.session.getSessionStats() ?? null;
  });

  ipcMain.handle("metaharn:forkChatSession", (event: IpcMainInvokeEvent) => {
    const entry = sessionsByWindow.get(event.sender.id);
    if (!entry || entry.kind !== "pi") return null;
    // Pi's real fork() (new session file + runtime swap) lives on
    // AgentSessionRuntime, an object MetaHarn never adopted — createAgentSession
    // is used directly instead (see agent.ts). SessionManager's own
    // createBranchedSession() does the same practical thing at a lower
    // level: writes a new, independent session file containing just the
    // root-to-leaf path, without needing that larger abstraction.
    const leafId = entry.sessionManager.getLeafId();
    if (!leafId) return null;
    const newPath = entry.sessionManager.createBranchedSession(leafId);
    return newPath ? { path: newPath } : null;
  });
}
