import { useEffect, useState } from "react";
import type { ProjectListItem, SessionListItem } from "../preload/preload.js";
import { computeProjectStats, formatRelativeTime } from "./format.js";
import { ArchiveIcon, BranchIcon, ChatIcon, ClockIcon, DownloadIcon, FolderIcon, PlusIcon, TrashIcon } from "./icons.js";
import { Eyebrow, MetaChip } from "./ui.js";

interface ProjectsListPageProps {
  projects: ProjectListItem[];
  sessions: SessionListItem[];
  activeCwd?: string;
  onSelectProject: (cwd: string) => void;
  onNewProject: () => void;
  onImportProject: () => void;
  onRemoveProject: (project: ProjectListItem) => void;
  onArchiveProject: (project: ProjectListItem) => void;
  onUnarchiveProject: (project: ProjectListItem) => void;
}

// "Last Session" and "Most Visited" modes existed here once but were a
// fake distinction — MetaHarn doesn't track per-project visit counts or a
// last-session-opened timestamp separate from "most recent session
// modified," so both silently produced the exact same order as "Recently
// Changed" while still changing the selected pill, a bug pattern in itself
// (visible state changes, actual output doesn't). Removed rather than
// faked; add real visitCount/lastSessionOpenedAt tracking if these are
// wanted back as genuine distinctions.
type SortMode = "recent" | "active";
const SORT_LABELS: { mode: SortMode; label: string }[] = [
  { mode: "recent", label: "Recently Changed" },
  { mode: "active", label: "Active Sessions" },
];

export default function ProjectsListPage({
  projects,
  sessions,
  activeCwd,
  onSelectProject,
  onNewProject,
  onImportProject,
  onRemoveProject,
  onArchiveProject,
  onUnarchiveProject,
}: ProjectsListPageProps) {
  const [sort, setSort] = useState<SortMode>("recent");
  const projectStats = computeProjectStats(sessions);
  const [archivedOpen, setArchivedOpen] = useState(false);
  // Fetched lazily, only once the "Archived" section is actually opened —
  // same per-section lazy-fetch principle GitPanel.tsx's tabs already use,
  // not kept in App.tsx's always-on state since nothing else needs it.
  const [archived, setArchived] = useState<ProjectListItem[] | undefined>(undefined);

  const refreshArchived = () => {
    void window.metaharn.listArchivedProjects().then(setArchived);
  };

  useEffect(() => {
    if (archivedOpen && archived === undefined) refreshArchived();
  }, [archivedOpen, archived]);

  // Wrap the App.tsx-level handlers so THIS page's own local `archived`
  // list (App.tsx doesn't track it globally, see above) stays in sync too
  // — archiving a project should make it disappear from the active list
  // AND appear in Archived without a manual reopen; unarchiving the
  // reverse.
  const archiveProject = (project: ProjectListItem) => {
    onArchiveProject(project);
    setArchived(undefined);
  };
  const unarchiveProject = (project: ProjectListItem) => {
    onUnarchiveProject(project);
    setArchived(undefined);
  };

  const sorted = [...projects].sort((a, b) => {
    if (sort === "active") {
      const aActive = a.localPath === activeCwd ? 1 : 0;
      const bActive = b.localPath === activeCwd ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
    }
    const aTime = projectStats.get(a.localPath)?.lastActivity?.getTime() ?? 0;
    const bTime = projectStats.get(b.localPath)?.lastActivity?.getTime() ?? 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.name.localeCompare(b.name);
  });

  return (
    <div style={{ maxWidth: 780, overflowY: "auto", height: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 26 }}>Your Projects</h1>
          <p style={{ margin: "4px 0 0", color: "var(--color-text-secondary)", fontSize: 13 }}>
            {projects.length} project{projects.length === 1 ? "" : "s"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onImportProject}
            className="metaharn-icon-btn"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              background: "transparent",
              color: "var(--color-text-secondary)",
              cursor: "pointer",
              padding: "8px 14px",
              fontSize: 13,
            }}
          >
            <DownloadIcon size={14} />
            Import
          </button>
          <button
            className="metaharn-btn-primary"
            onClick={onNewProject}
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <PlusIcon size={14} />
            Add Project
          </button>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <span style={{ fontSize: 12, color: "var(--color-text-muted)", fontWeight: 600, letterSpacing: 0.3 }}>
          SORT
        </span>
        <div
          style={{
            display: "flex",
            gap: 2,
            padding: 2,
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            background: "var(--color-bg-secondary)",
          }}
        >
          {SORT_LABELS.map(({ mode, label }) => (
            <button
              key={mode}
              onClick={() => setSort(mode)}
              style={{
                padding: "5px 12px",
                border: "none",
                borderRadius: 6,
                background: sort === mode ? "var(--color-bg-elevated)" : "transparent",
                color: sort === mode ? "var(--color-text)" : "var(--color-text-secondary)",
                fontWeight: sort === mode ? 600 : 400,
                cursor: "pointer",
                fontSize: 12.5,
                boxShadow: sort === mode ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {sorted.length === 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
            padding: "56px 24px",
            border: "1px dashed var(--color-border)",
            borderRadius: 12,
            color: "var(--color-text-secondary)",
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              background: "var(--color-accent-soft)",
              color: "var(--color-accent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 14,
            }}
          >
            <FolderIcon size={22} />
          </div>
          <p style={{ margin: "0 0 4px", color: "var(--color-text)", fontWeight: 600, fontSize: 15 }}>
            No projects yet
          </p>
          <p style={{ margin: "0 0 18px", fontSize: 13 }}>Add a local repo to start working with the agent.</p>
          <button
            className="metaharn-btn-primary"
            onClick={onNewProject}
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <PlusIcon size={14} />
            Add Project
          </button>
        </div>
      )}

      {sorted.map((project) => {
        const stats = projectStats.get(project.localPath);
        return (
          <ProjectRow
            key={project.id}
            project={project}
            sessionCount={stats?.count ?? 0}
            lastActivity={stats?.lastActivity}
            active={project.localPath === activeCwd}
            onSelect={() => onSelectProject(project.localPath)}
            onRemove={() => onRemoveProject(project)}
            onArchive={() => archiveProject(project)}
          />
        );
      })}

      <div style={{ marginTop: 28 }}>
        <button
          onClick={() => setArchivedOpen((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            padding: 0,
            marginBottom: archivedOpen ? 10 : 0,
          }}
        >
          <span style={{ color: "var(--color-text-muted)", fontSize: 10 }}>{archivedOpen ? "▾" : "▸"}</span>
          <Eyebrow>Archived{archived ? ` (${archived.length})` : ""}</Eyebrow>
        </button>

        {archivedOpen && (
          <>
            {archived === undefined && (
              <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>Loading...</p>
            )}
            {archived?.length === 0 && (
              <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>No archived projects.</p>
            )}
            {archived?.map((project) => (
              <ArchivedRow
                key={project.id}
                project={project}
                onUnarchive={() => unarchiveProject(project)}
                onRemove={() => onRemoveProject(project)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** Deliberately plainer than the active ProjectRow — no branch/session/
 * last-activity fetch, this is a secondary, out-of-the-way surface, not
 * the main working list. */
function ArchivedRow({
  project,
  onUnarchive,
  onRemove,
}: {
  project: ProjectListItem;
  onUnarchive: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className="metaharn-card-row"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        marginBottom: 6,
        padding: "8px 12px",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{project.name}</div>
        <div
          style={{
            fontSize: 11,
            color: "var(--color-text-muted)",
            fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {project.localPath}
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        <button
          onClick={onUnarchive}
          aria-label="Restore project"
          className="metaharn-icon-btn metaharn-tooltip"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            background: "transparent",
            color: "var(--color-text-muted)",
            cursor: "pointer",
            width: 28,
            height: 28,
            borderRadius: 6,
          }}
        >
          <ArchiveIcon size={14} />
        </button>
        <button
          onClick={onRemove}
          aria-label="Remove permanently"
          className="metaharn-icon-btn metaharn-tooltip"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            background: "transparent",
            color: "var(--color-text-muted)",
            cursor: "pointer",
            width: 28,
            height: 28,
            borderRadius: 6,
          }}
        >
          <TrashIcon size={14} />
        </button>
      </div>
    </div>
  );
}

function ProjectRow({
  project,
  sessionCount,
  lastActivity,
  active,
  onSelect,
  onRemove,
  onArchive,
}: {
  project: ProjectListItem;
  sessionCount: number;
  lastActivity?: Date;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onArchive: () => void;
}) {
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    void window.metaharnFiles.getGitBranch(project.localPath).then(setBranch);
  }, [project.localPath]);

  return (
    <div
      className="metaharn-card-row"
      style={{
        display: "flex",
        alignItems: "center",
        border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border)"}`,
        borderRadius: 10,
        marginBottom: 10,
        background: "var(--color-bg-elevated)",
      }}
    >
      <button
        onClick={onSelect}
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 14,
          textAlign: "left",
          padding: 14,
          border: "none",
          background: "transparent",
          color: "var(--color-text)",
          cursor: "pointer",
        }}
      >
        <div
          style={{
            flexShrink: 0,
            width: 38,
            height: 38,
            borderRadius: 9,
            background: "var(--color-accent-soft)",
            color: "var(--color-accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <FolderIcon size={18} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 14.5 }}>{project.name}</span>
            {active && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--color-accent)",
                  background: "var(--color-accent-soft)",
                  borderRadius: 5,
                  padding: "1px 7px",
                }}
              >
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: "var(--color-accent)",
                    display: "inline-block",
                  }}
                />
                Active
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--color-text-muted)",
              fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
              margin: "2px 0 7px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {project.localPath}
          </div>
          <div style={{ display: "flex", gap: 14, fontSize: 12, color: "var(--color-text-secondary)" }}>
            {lastActivity && <MetaChip icon={<ClockIcon size={13} />}>{formatRelativeTime(lastActivity)}</MetaChip>}
            {branch && <MetaChip icon={<BranchIcon size={13} />}>{branch}</MetaChip>}
            <MetaChip icon={<ChatIcon size={13} />}>
              {sessionCount} session{sessionCount === 1 ? "" : "s"}
            </MetaChip>
          </div>
        </div>
      </button>
      <div className="metaharn-hover-actions" style={{ display: "flex", flexShrink: 0, marginRight: 10 }}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onArchive();
          }}
          aria-label="Archive project"
          className="metaharn-icon-btn metaharn-tooltip"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            background: "transparent",
            color: "var(--color-text-muted)",
            cursor: "pointer",
            width: 34,
            height: 34,
            borderRadius: 8,
          }}
        >
          <ArchiveIcon size={15} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label="Remove project"
          className="metaharn-icon-btn metaharn-tooltip"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            background: "transparent",
            color: "var(--color-text-muted)",
            cursor: "pointer",
            width: 34,
            height: 34,
            borderRadius: 8,
          }}
        >
          <TrashIcon size={15} />
        </button>
      </div>
    </div>
  );
}
