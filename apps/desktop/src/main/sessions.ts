import { shell } from "electron";
import { eq } from "drizzle-orm";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { db, repos, sessions as sessionsTable } from "@metaharn/db";
import type { AgentKind } from "./agents/types.js";
import { listArchivedSessionTimestamps, listArchivedTerminalSessions } from "./catalog.js";

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
  /** Only meaningful for type "terminal" — which real CLI this session
   * runs. Absent on chat sessions (always Pi, not one of these adapters). */
  agentKind?: AgentKind;
}

/**
 * All past sessions across every project, for the sidebar — chat sessions
 * (discovered from Pi's own JSONL files on disk, authoritative) merged with
 * MetaHarn's own tracked terminal sessions (no Pi transcript exists for
 * these, so the catalog DB row is the only record of them; see
 * catalog.ts's createTerminalSession). Archived sessions are filtered out
 * here, at the source, same "filter once, every consumer benefits" pattern
 * listRepos()/listWorktreeRepoIds() already established — the disk scan
 * itself has no concept of archivedAt (only the catalog DB does), so the
 * archived-id set is fetched once and applied to BOTH branches below.
 */
export async function listAllSessions(): Promise<SessionListItem[]> {
  const archivedAtById = await listArchivedSessionTimestamps();

  const chatSessions: SessionListItem[] = (await SessionManager.listAll())
    .filter((s) => !archivedAtById.has(s.id))
    .map((s) => ({
      ...s,
      type: "chat" as const,
    }));

  const terminalRows = await db
    .select({
      id: sessionsTable.id,
      title: sessionsTable.title,
      createdAt: sessionsTable.createdAt,
      updatedAt: sessionsTable.updatedAt,
      agentKind: sessionsTable.agentKind,
      localPath: repos.localPath,
    })
    .from(sessionsTable)
    .innerJoin(repos, eq(sessionsTable.repoId, repos.id))
    .where(eq(sessionsTable.type, "terminal"));

  const terminalSessions: SessionListItem[] = terminalRows
    .filter((row) => !archivedAtById.has(row.id))
    .map((row) => ({
      type: "terminal",
      path: row.id,
      id: row.id,
      cwd: row.localPath,
      name: row.title ?? undefined,
      created: row.createdAt,
      modified: row.updatedAt,
      messageCount: 0,
      firstMessage: "",
      agentKind: row.agentKind as AgentKind,
    }));

  return [...chatSessions, ...terminalSessions];
}

export interface ArchivedSessionItem extends SessionListItem {
  archivedAt: Date;
}

/**
 * The mirror image of listAllSessions() above — archived sessions only,
 * optionally scoped to one project's cwd (ProjectOverview.tsx's "ARCHIVED
 * SESSIONS" section; unscoped isn't used yet but costs nothing to support).
 * Chat sessions still come from the disk scan (archiving never deletes the
 * real JSONL file, so SessionManager still finds it) filtered TO the
 * archived id set instead of excluding it; terminal sessions are a direct
 * DB query (catalog.ts's listArchivedTerminalSessions).
 */
export async function listArchivedSessions(cwd?: string): Promise<ArchivedSessionItem[]> {
  const archivedAtById = await listArchivedSessionTimestamps();
  if (archivedAtById.size === 0) return [];

  const chatSessions: ArchivedSessionItem[] = (await SessionManager.listAll())
    .filter((s) => archivedAtById.has(s.id) && (!cwd || s.cwd === cwd))
    .map((s) => ({
      ...s,
      type: "chat" as const,
      archivedAt: archivedAtById.get(s.id) ?? new Date(0),
    }));

  const terminalRows = await listArchivedTerminalSessions(cwd);
  const terminalSessions: ArchivedSessionItem[] = terminalRows.map((row) => ({
    type: "terminal",
    path: row.id,
    id: row.id,
    cwd: row.localPath,
    name: row.title ?? undefined,
    created: row.createdAt,
    modified: row.updatedAt,
    messageCount: 0,
    firstMessage: "",
    agentKind: row.agentKind as AgentKind,
    archivedAt: row.archivedAt!,
  }));

  return [...chatSessions, ...terminalSessions];
}

/**
 * Moves a session's JSONL file to the OS trash rather than unlinking it —
 * matches Pi's own `/resume` picker (which prefers the `trash` CLI over a
 * permanent delete when available) and means an accidental delete is still
 * recoverable.
 */
export async function deleteSession(sessionPath: string): Promise<void> {
  await shell.trashItem(sessionPath);
}

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  text: string;
}

/**
 * Flattens a resumed session's full message tree into the same simple
 * {role, text} shape the chat UI already renders live turns as — so
 * resuming a session looks the same as watching one happen.
 */
export function messagesToHistory(messages: AgentMessage[]): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  for (const message of messages) {
    if (!("role" in message)) continue;
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("");
      if (text) history.push({ role: "user", text });
    } else if (message.role === "assistant") {
      const text = message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (text) history.push({ role: "assistant", text });
    } else if (message.role === "toolResult") {
      history.push({ role: "tool", text: `${message.isError ? "failed" : "done"}: ${message.toolName}` });
    }
  }
  return history;
}

export interface SessionTreeNodeDTO {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  label?: string;
  preview: string;
  children: SessionTreeNodeDTO[];
}

/** Short human-readable summary for one tree node, keyed off the entry's own type. */
function previewFor(entry: SessionEntry): string {
  switch (entry.type) {
    case "message": {
      const [history] = messagesToHistory([entry.message]);
      return history ? `${history.role}: ${history.text.slice(0, 80)}` : entry.message.role;
    }
    case "compaction":
      return `compacted: ${entry.summary.slice(0, 80)}`;
    case "branch_summary":
      return `branch: ${entry.summary.slice(0, 80)}`;
    case "model_change":
      return `model → ${entry.provider}/${entry.modelId}`;
    case "thinking_level_change":
      return `thinking level → ${entry.thinkingLevel}`;
    case "session_info":
      return entry.name ? `renamed: ${entry.name}` : "session info";
    case "label":
      return entry.label ? `label: ${entry.label}` : "label cleared";
    case "custom_message":
      return typeof entry.content === "string" ? entry.content.slice(0, 80) : "custom message";
    case "custom":
      return `custom: ${entry.customType}`;
  }
}

/**
 * Flattens SessionManager.getTree()'s SDK-shaped nodes (a full SessionEntry
 * union per node) down to just what the tree UI needs — keeps the renderer
 * decoupled from Pi's internal entry types the same way messagesToHistory
 * decouples it from AgentMessage.
 */
export function treeToDTO(nodes: SessionTreeNode[]): SessionTreeNodeDTO[] {
  return nodes.map((node) => ({
    id: node.entry.id,
    parentId: node.entry.parentId,
    type: node.entry.type,
    timestamp: node.entry.timestamp,
    label: node.label,
    preview: previewFor(node.entry),
    children: treeToDTO(node.children),
  }));
}
