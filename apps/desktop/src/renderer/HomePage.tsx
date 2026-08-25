import { useState } from "react";
import type { ProjectListItem, SessionListItem } from "../preload/preload.js";
import { computeProjectStats } from "./format.js";
import { FolderIcon, SendIcon } from "./icons.js";
import { RADIUS, SPACE, TEXT } from "./ui.js";

interface HomePageProps {
  projects: ProjectListItem[];
  sessions: SessionListItem[];
  onStart: (project: ProjectListItem, prompt: string) => void;
  onShowAllProjects: () => void;
  onImportProject: () => void;
}

const MAX_PILLS = 5;

/**
 * The app's true landing page (App.tsx's initial view, and where the
 * brand mark now goes) — a "Dream big, start here" launcher. One text
 * box + a project picker; submitting creates a real new
 * terminal session in the chosen project with the typed text as the
 * agent's actual initial prompt (see ipc.ts's metaharn:createTerminalSession
 * — passed through as a CLI launch arg via setPendingSeedPrompt, the same
 * one-shot mechanism the agent-swap handoff already used, not simulated
 * keystrokes into the pty).
 */
export default function HomePage({ projects, sessions, onStart, onShowAllProjects, onImportProject }: HomePageProps) {
  const [prompt, setPrompt] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const projectStats = computeProjectStats(sessions);
  const recentProjects = [...projects]
    .sort((a, b) => {
      const aTime = projectStats.get(a.localPath)?.lastActivity?.getTime() ?? 0;
      const bTime = projectStats.get(b.localPath)?.lastActivity?.getTime() ?? 0;
      if (aTime !== bTime) return bTime - aTime;
      return a.name.localeCompare(b.name);
    })
    .slice(0, MAX_PILLS);

  // Most-recently-active project is the default target — Enter just works
  // for the common "continue what I was just doing" case — but clicking
  // any other pill overrides it, which is the actual "option to select
  // the project" this screen exists to offer.
  const selected = recentProjects.find((p) => p.localPath === selectedPath) ?? recentProjects[0] ?? null;

  const handleSubmit = () => {
    if (!selected || !prompt.trim()) return;
    onStart(selected, prompt.trim());
    setPrompt("");
  };

  if (projects.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: SPACE.md }}>
        <p style={{ color: "var(--color-text-secondary)", fontSize: TEXT.md }}>No projects yet — import one to get started.</p>
        <button className="metaharn-btn-primary" onClick={onImportProject}>
          Import a project
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: SPACE.lg }}>
      <div style={{ width: "100%", maxWidth: 640, position: "relative" }}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          autoFocus
          rows={3}
          placeholder="Describe what you want to build — starts a new terminal session in the project below."
          style={{
            width: "100%",
            resize: "none",
            padding: `${SPACE.md}px ${SPACE.md + 36}px ${SPACE.md}px ${SPACE.md}px`,
            border: "1px solid var(--color-border)",
            borderRadius: RADIUS.lg,
            background: "var(--color-bg-elevated)",
            color: "var(--color-text)",
            fontSize: TEXT.md,
            fontFamily: "inherit",
            lineHeight: 1.5,
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={!selected || !prompt.trim()}
          aria-label="Start session"
          className="metaharn-tooltip"
          style={{
            position: "absolute",
            right: SPACE.sm,
            bottom: SPACE.sm,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 30,
            height: 30,
            border: "none",
            borderRadius: RADIUS.md,
            background: selected && prompt.trim() ? "var(--color-accent)" : "var(--color-bg-hover)",
            color: selected && prompt.trim() ? "#fff" : "var(--color-text-muted)",
            cursor: selected && prompt.trim() ? "pointer" : "default",
          }}
        >
          <SendIcon size={15} />
        </button>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: SPACE.sm, maxWidth: 640 }}>
        {recentProjects.map((project) => {
          const active = project.localPath === selected?.localPath;
          return (
            <button
              key={project.id}
              onClick={() => setSelectedPath(project.localPath)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border)"}`,
                borderRadius: RADIUS.xl,
                background: active ? "var(--color-accent-soft)" : "transparent",
                color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
                cursor: "pointer",
                fontSize: TEXT.sm,
              }}
            >
              <FolderIcon size={13} />
              {project.name}
            </button>
          );
        })}
      </div>

      <button
        onClick={onShowAllProjects}
        style={{
          border: "none",
          background: "transparent",
          color: "var(--color-text-muted)",
          cursor: "pointer",
          fontSize: TEXT.sm,
        }}
      >
        View all projects →
      </button>
    </div>
  );
}
