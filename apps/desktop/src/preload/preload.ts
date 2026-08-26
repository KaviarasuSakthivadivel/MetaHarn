import { contextBridge, ipcRenderer } from "electron";

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  text: string;
}

/** What a client should do about one pending approval — mirrors @metaharn/engine's
 * ApprovalOutcome (the owned-engine backend's PermissionEngine understands all of these;
 * "once" is the only one a bare Approve/Deny UI needs to send). */
export type ApprovalOutcome = "once" | "always_tool" | "always_command" | "always_domain" | "readonly_session" | "deny";

export type MetaHarnEvent =
  | { type: "ready"; sessionId: string; history: HistoryMessage[] }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  // Owned-engine backend only (METAHARN_CHAT_ENGINE=owned) — Pi never emits this; its own
  // approval flow, if any, is internal to the SDK. See ownedEngine.ts.
  | { type: "permission_required"; toolCallId: string; toolName: string; args: unknown; reason: string }
  | { type: "agent_end" }
  | { type: "error"; message: string };

/** The real CLI coding agent a terminal session runs — see
 * apps/desktop/src/main/agents/ for each one's adapter. */
export type AgentKind = "claude" | "codex" | "gemini" | "opencode";

export interface AgentInfo {
  kind: AgentKind;
  displayName: string;
}

export interface AgentStatus {
  kind: AgentKind;
  displayName: string;
  installed: boolean;
  version: string | null;
  /** null means the npm registry lookup itself failed (offline, etc.) —
   * distinct from "no update available." */
  latestVersion: string | null;
  updateAvailable: boolean;
}

export interface AgentCommandResult {
  ok: boolean;
  output: string;
}

export interface SessionListItem {
  type: "chat" | "terminal";
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  /** Only meaningful for type "terminal". */
  agentKind?: AgentKind;
}

/** SessionListItem, plus when it was archived — metaharn:listArchivedSessions'
 * return shape (see sessions.ts's ArchivedSessionItem). */
export interface ArchivedSessionItem extends SessionListItem {
  archivedAt: Date;
}

export interface WorktreeSessionResult {
  worktreePath: string;
  parentType: "chat" | "terminal";
  parentAgentKind: AgentKind;
}

/** A visual-only "this session's work relates to that one" annotation shown
 * in the sidebar's minimap — never a git relationship. See
 * packages/db/src/schema.ts's sessionDependencies doc comment. */
export interface SessionDependency {
  sessionId: string;
  dependsOnSessionId: string;
}

/** Documents that `cwd` is a real `git worktree` checkout of `parentCwd` —
 * see packages/db/src/schema.ts's projectWorktrees doc comment. Used to
 * exclude worktree checkouts from the project list and merge their sessions
 * into their parent's Sidebar group. */
export interface WorktreeLink {
  cwd: string;
  parentCwd: string;
  branch: string;
  createdAt: Date;
}

export interface ProjectListItem {
  id: string;
  name: string;
  localPath: string;
}

/** What removeProject is actually about to destroy — real counts fetched
 * before showing the confirmation dialog, not a guess. See
 * catalog.ts's getProjectDeletionPreview. */
export interface ProjectDeletionPreview {
  sessionCount: number;
  worktrees: { cwd: string; branch: string }[];
}

export interface AppInfo {
  version: string;
  provider: string;
  modelId: string;
}

export interface SessionTreeNode {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  label?: string;
  preview: string;
  children: SessionTreeNode[];
}

/** The *latest turn's* context payload size — distinct from SessionStats.tokens,
 * which is cumulative over the whole session. `tokens`/`percent` are null right
 * after compaction, before the next LLM response re-establishes a real count. */
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface SessionStats {
  sessionFile: string | undefined;
  sessionId: string;
  /** Not part of Pi's real SessionStats (chat sessions get their model from
   * appInfo.modelId instead) — only set for terminal-session-sourced stats,
   * where it's the only place the model is observed from (the transcript). */
  model?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: ContextUsage;
}

const metaharnBridge = {
  init: (repoPath: string, resumeSessionPath?: string) =>
    ipcRenderer.invoke("metaharn:init", repoPath, resumeSessionPath),
  prompt: (text: string) => ipcRenderer.invoke("metaharn:prompt", text),
  steer: (text: string) => ipcRenderer.invoke("metaharn:steer", text),
  followUp: (text: string) => ipcRenderer.invoke("metaharn:followUp", text),
  listSessions: (): Promise<SessionListItem[]> => ipcRenderer.invoke("metaharn:listSessions"),
  registerProject: (cwd: string): Promise<ProjectListItem> => ipcRenderer.invoke("metaharn:registerProject", cwd),
  listProjects: (): Promise<ProjectListItem[]> => ipcRenderer.invoke("metaharn:listProjects"),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("metaharn:getAppInfo"),
  deleteSession: (sessionPath: string): Promise<void> => ipcRenderer.invoke("metaharn:deleteSession", sessionPath),
  createTerminalSession: (cwd: string, agentKind: AgentKind, seedPrompt?: string): Promise<{ id: string }> =>
    ipcRenderer.invoke("metaharn:createTerminalSession", cwd, agentKind, seedPrompt),
  deleteTerminalSession: (id: string): Promise<void> => ipcRenderer.invoke("metaharn:deleteTerminalSession", id),
  renameTerminalSession: (id: string, title: string): Promise<void> =>
    ipcRenderer.invoke("metaharn:renameTerminalSession", id, title),
  createWorktreeSession: (parentSessionId: string): Promise<WorktreeSessionResult> =>
    ipcRenderer.invoke("metaharn:createWorktreeSession", parentSessionId),
  setSessionDependency: (sessionId: string, dependsOnSessionId: string): Promise<void> =>
    ipcRenderer.invoke("metaharn:setSessionDependency", sessionId, dependsOnSessionId),
  removeSessionDependency: (sessionId: string, dependsOnSessionId: string): Promise<void> =>
    ipcRenderer.invoke("metaharn:removeSessionDependency", sessionId, dependsOnSessionId),
  getSessionDependencies: (): Promise<SessionDependency[]> => ipcRenderer.invoke("metaharn:getSessionDependencies"),
  getWorktreeLinks: (): Promise<WorktreeLink[]> => ipcRenderer.invoke("metaharn:getWorktreeLinks"),
  createWorktreeFromProject: (cwd: string): Promise<{ worktreePath: string; branch: string }> =>
    ipcRenderer.invoke("metaharn:createWorktreeFromProject", cwd),
  /** Real `git worktree remove --force`, plus its catalog cleanup — see
   * ipc.ts's metaharn:removeWorktreeSession. Permanent; the caller is
   * expected to have already shown the real uncommitted-changes list
   * (getGitChanges) before calling this. */
  removeWorktreeSession: (worktreePath: string): Promise<void> =>
    ipcRenderer.invoke("metaharn:removeWorktreeSession", worktreePath),
  /** Never forced — see git.ts's checkoutBranch doc comment. Rejects with
   * the real git error (e.g. uncommitted changes in the way) if it fails. */
  checkoutBranch: (cwd: string, branch: string): Promise<void> =>
    ipcRenderer.invoke("metaharn:checkoutBranch", cwd, branch),
  /** `checkout -b` — creates and switches to a new local branch from HEAD.
   * Real error propagates (e.g. name already exists). */
  createBranch: (cwd: string, name: string): Promise<void> => ipcRenderer.invoke("metaharn:createBranch", cwd, name),
  /** `git branch -d` (or `-D` when `force`) — see git.ts's deleteBranch doc
   * comment for the two-step force-on-real-failure pattern callers use. */
  deleteBranch: (cwd: string, name: string, force: boolean): Promise<void> =>
    ipcRenderer.invoke("metaharn:deleteBranch", cwd, name, force),
  /** Opens the commit-diff window (a real second BrowserWindow, not a
   * MainView — see main.ts's createCommitDiffWindow) for one commit. */
  openCommitDiffWindow: (cwd: string, hash: string): Promise<void> =>
    ipcRenderer.invoke("metaharn:openCommitDiffWindow", cwd, hash),
  /** Opens the branch/commit browser (a real second BrowserWindow, not a
   * MainView — see main.ts's createBranchExplorerWindow), optionally
   * pre-scoped to one branch. */
  openBranchExplorerWindow: (cwd: string, branch?: string): Promise<void> =>
    ipcRenderer.invoke("metaharn:openBranchExplorerWindow", cwd, branch),
  listAvailableAgents: (): Promise<AgentInfo[]> => ipcRenderer.invoke("metaharn:listAvailableAgents"),
  swapTerminalSessionAgent: (id: string, cwd: string, agentKind: AgentKind): Promise<{ ok: boolean; handedOffContext: boolean }> =>
    ipcRenderer.invoke("metaharn:swapTerminalSessionAgent", id, cwd, agentKind),
  getAgentStatuses: (): Promise<AgentStatus[]> => ipcRenderer.invoke("metaharn:getAgentStatuses"),
  installAgent: (kind: AgentKind): Promise<AgentCommandResult> => ipcRenderer.invoke("metaharn:installAgent", kind),
  uninstallAgent: (kind: AgentKind): Promise<AgentCommandResult> => ipcRenderer.invoke("metaharn:uninstallAgent", kind),
  upgradeAgent: (kind: AgentKind): Promise<AgentCommandResult> => ipcRenderer.invoke("metaharn:upgradeAgent", kind),
  forkTerminalSession: (
    cwd: string,
    sourceId: string,
    sourceTitle?: string,
  ): Promise<{ id?: string; hasHistory: boolean; reason?: string }> =>
    ipcRenderer.invoke("metaharn:forkTerminalSession", cwd, sourceId, sourceTitle),
  getTerminalSessionStats: (cwd: string, sessionId: string): Promise<SessionStats | null> =>
    ipcRenderer.invoke("metaharn:getTerminalSessionStats", cwd, sessionId),
  removeProject: (repoId: string): Promise<void> => ipcRenderer.invoke("metaharn:removeProject", repoId),
  getProjectDeletionPreview: (repoId: string): Promise<ProjectDeletionPreview> =>
    ipcRenderer.invoke("metaharn:getProjectDeletionPreview", repoId),
  archiveProject: (repoId: string): Promise<void> => ipcRenderer.invoke("metaharn:archiveProject", repoId),
  unarchiveProject: (repoId: string): Promise<void> => ipcRenderer.invoke("metaharn:unarchiveProject", repoId),
  listArchivedProjects: (): Promise<ProjectListItem[]> => ipcRenderer.invoke("metaharn:listArchivedProjects"),
  archiveSession: (id: string): Promise<void> => ipcRenderer.invoke("metaharn:archiveSession", id),
  unarchiveSession: (id: string): Promise<void> => ipcRenderer.invoke("metaharn:unarchiveSession", id),
  listArchivedSessions: (cwd?: string): Promise<ArchivedSessionItem[]> =>
    ipcRenderer.invoke("metaharn:listArchivedSessions", cwd),
  abort: (): Promise<void> => ipcRenderer.invoke("metaharn:abort"),
  /** Answers a "permission_required" event from the owned-engine backend. A no-op for a
   * Pi-backed session. */
  resolvePermission: (toolCallId: string, outcome: ApprovalOutcome): Promise<void> =>
    ipcRenderer.invoke("metaharn:resolvePermission", toolCallId, outcome),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("metaharn:pickDirectory"),
  getSessionTree: (): Promise<SessionTreeNode[]> => ipcRenderer.invoke("metaharn:getSessionTree"),
  branchSession: (entryId: string): Promise<void> => ipcRenderer.invoke("metaharn:branchSession", entryId),
  getSessionStats: (): Promise<SessionStats | null> => ipcRenderer.invoke("metaharn:getSessionStats"),
  forkChatSession: (): Promise<{ path: string } | null> => ipcRenderer.invoke("metaharn:forkChatSession"),
  onEvent: (callback: (event: MetaHarnEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: MetaHarnEvent) => callback(event);
    ipcRenderer.on("metaharn:event", listener);
    return () => {
      ipcRenderer.removeListener("metaharn:event", listener);
    };
  },
};

contextBridge.exposeInMainWorld("metaharn", metaharnBridge);

export type MetaHarnBridge = typeof metaharnBridge;

export interface PtyDataEvent {
  ptyId: number;
  terminalSessionId: string;
  data: string;
}

export interface PtyExitEvent {
  ptyId: number;
  terminalSessionId: string;
  exitCode: number;
  signal?: number;
}

const metaharnPtyBridge = {
  /** Attach-or-create: if this session already has a live pty (e.g. its tab
   * was just switched to, not freshly opened), returns its existing ptyId
   * untouched — never kills/respawns a running session just for being
   * reattached to. `scrollback` is everything that pty has written since it
   * spawned (capped, see pty-ipc.ts) — write it to the terminal before
   * treating this instance as live, since a freshly-mounted xterm (a second
   * grid instance, or a reopened tab) otherwise starts blank and only shows
   * whatever's written AFTER it happened to mount. */
  create: (cwd: string, terminalSessionId: string): Promise<{ ptyId: number; scrollback: string }> =>
    ipcRenderer.invoke("metaharn:ptyCreate", cwd, terminalSessionId),
  write: (terminalSessionId: string, data: string) => ipcRenderer.invoke("metaharn:ptyWrite", terminalSessionId, data),
  resize: (terminalSessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke("metaharn:ptyResize", terminalSessionId, cols, rows),
  /** Explicit close — distinct from navigating away, which must NOT kill
   * the underlying process. Only call this from an actual "close this tab"
   * action. */
  close: (terminalSessionId: string): Promise<void> => ipcRenderer.invoke("metaharn:ptyClose", terminalSessionId),
  onData: (callback: (event: PtyDataEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: PtyDataEvent) => callback(event);
    ipcRenderer.on("metaharn:ptyData", listener);
    return () => {
      ipcRenderer.removeListener("metaharn:ptyData", listener);
    };
  },
  onExit: (callback: (event: PtyExitEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: PtyExitEvent) => callback(event);
    ipcRenderer.on("metaharn:ptyExit", listener);
    return () => {
      ipcRenderer.removeListener("metaharn:ptyExit", listener);
    };
  },
};

contextBridge.exposeInMainWorld("metaharnPty", metaharnPtyBridge);

export type MetaHarnPtyBridge = typeof metaharnPtyBridge;

export type GitFileStatus = "modified" | "added" | "deleted" | "untracked" | "renamed";

export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileTreeNode[];
  /** Only ever set on files. Absent for a clean file or a non-git root. */
  gitStatus?: GitFileStatus;
}

export interface GitChange {
  path: string;
  status: GitFileStatus;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  refs: string[];
  /** Parent commit hashes — empty for a root commit, 2+ for a merge. Powers
   * the commit-graph lane/line rendering (see renderer/graphLayout.ts). */
  parents: string[];
}

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  lastCommitDate: string;
}

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  lastCommitDate: string;
  ahead: number;
  behind: number;
}

export interface RemoteBranchInfo {
  remote: string;
  name: string;
}

export interface CommitMeta {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export type CommitFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface CommitFileEntry {
  path: string;
  status: CommitFileStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface CommitFileList {
  files: CommitFileEntry[];
  totalCount: number;
  truncated: boolean;
}

export interface FileDiffContent {
  oldContent: string | null;
  newContent: string | null;
}

const metaharnFilesBridge = {
  listTree: (root: string): Promise<FileTreeNode[]> => ipcRenderer.invoke("metaharn:fsListTree", root),
  readFile: (root: string, relPath: string): Promise<string> =>
    ipcRenderer.invoke("metaharn:fsReadFile", root, relPath),
  writeFile: (root: string, relPath: string, content: string): Promise<void> =>
    ipcRenderer.invoke("metaharn:fsWriteFile", root, relPath, content),
  getGitBranch: (cwd: string): Promise<string | null> => ipcRenderer.invoke("metaharn:getGitBranch", cwd),
  getGitStatus: (cwd: string): Promise<"clean" | "dirty" | null> => ipcRenderer.invoke("metaharn:getGitStatus", cwd),
  /** Real, uncommitted changes — a list, not a diff (see git.ts's
   * getGitChanges). `null` means not a git repo. */
  getGitChanges: (cwd: string): Promise<GitChange[] | null> => ipcRenderer.invoke("metaharn:getGitChanges", cwd),
  /** Paginated — `skip`/`limit` are required, not optional, since a mono
   * repo's history can be huge (see git.ts's getGitLog doc comment). */
  getGitLog: (cwd: string, skip: number, limit: number, branch?: string): Promise<GitLogEntry[] | null> =>
    ipcRenderer.invoke("metaharn:getGitLog", cwd, skip, limit, branch),
  getGitBranches: (cwd: string): Promise<GitBranchInfo[] | null> => ipcRenderer.invoke("metaharn:getGitBranches", cwd),
  /** Richer sibling of getGitBranches — adds ahead/behind-vs-HEAD counts,
   * still one git process spawn regardless of branch count (see git.ts's
   * getGitBranchesDetailed doc comment). */
  getGitBranchesDetailed: (cwd: string): Promise<BranchInfo[] | null> =>
    ipcRenderer.invoke("metaharn:getGitBranchesDetailed", cwd),
  /** Read-only remote-tracking refs — no fetch/pull, just what's already
   * known locally. */
  getGitRemoteBranches: (cwd: string): Promise<RemoteBranchInfo[] | null> =>
    ipcRenderer.invoke("metaharn:getGitRemoteBranches", cwd),
  getCommitMeta: (cwd: string, hash: string): Promise<CommitMeta | null> =>
    ipcRenderer.invoke("metaharn:getCommitMeta", cwd, hash),
  /** Real file list + stats for one commit, capped server-side (see git.ts's
   * getCommitFileList doc comment) — never unbounded even for a mono-repo
   * commit touching thousands of files. */
  getCommitFileList: (cwd: string, hash: string): Promise<CommitFileList | null> =>
    ipcRenderer.invoke("metaharn:getCommitFileList", cwd, hash),
  /** Lazy, per-file — only call this for a file the user actually expanded,
   * not for every file in a commit up front. */
  getFileDiffContent: (cwd: string, hash: string, path: string): Promise<FileDiffContent> =>
    ipcRenderer.invoke("metaharn:getFileDiffContent", cwd, hash, path),
  /** HEAD-vs-working-tree equivalent of getFileDiffContent, for the Changes
   * tab's per-file diff view — `newContent` is read straight off disk, not
   * from git, since an uncommitted change isn't in git yet. Lazy per-file,
   * same convention. */
  getWorkingFileDiff: (cwd: string, path: string): Promise<FileDiffContent> =>
    ipcRenderer.invoke("metaharn:getWorkingFileDiff", cwd, path),
};

contextBridge.exposeInMainWorld("metaharnFiles", metaharnFilesBridge);

export type MetaHarnFilesBridge = typeof metaharnFilesBridge;
