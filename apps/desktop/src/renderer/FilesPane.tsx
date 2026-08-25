import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import "./monacoSetup.js";
import type { FileTreeNode, GitFileStatus } from "../preload/preload.js";
import { useResolvedTheme } from "./SettingsContext.js";

interface FilesPaneProps {
  cwd: string;
  /** True while the Files tab is the one actually shown — it stays mounted
   * (CSS-toggled) when switching to Overview, so this is how it knows to
   * refetch the tree on becoming visible again rather than only once ever,
   * per project, for the life of the view. */
  visible?: boolean;
}

const GIT_STATUS_STYLE: Record<GitFileStatus, { label: string; color: string }> = {
  modified: { label: "M", color: "var(--color-accent)" },
  added: { label: "A", color: "var(--color-success, #3fb950)" },
  deleted: { label: "D", color: "var(--color-error)" },
  untracked: { label: "U", color: "var(--color-text-muted)" },
  renamed: { label: "R", color: "var(--color-accent)" },
};

const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  sh: "shell",
  bash: "shell",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  rb: "ruby",
  php: "php",
  toml: "ini",
};

function languageForPath(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANGUAGE[ext] ?? "plaintext";
}

function TreeNode({
  node,
  depth,
  expanded,
  onToggle,
  selectedPath,
  onSelectFile,
}: {
  node: FileTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  selectedPath: string | undefined;
  onSelectFile: (path: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const statusStyle = node.gitStatus ? GIT_STATUS_STYLE[node.gitStatus] : undefined;
  return (
    <div>
      <button
        onClick={() => (node.isDirectory ? onToggle(node.path) : onSelectFile(node.path))}
        title={node.gitStatus ? `${node.name} — ${node.gitStatus}` : node.name}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          textAlign: "left",
          padding: "3px 8px",
          paddingLeft: 8 + depth * 12,
          border: "none",
          background: !node.isDirectory && node.path === selectedPath ? "var(--color-bg-hover)" : "transparent",
          color: statusStyle ? statusStyle.color : "var(--color-text)",
          cursor: "pointer",
          fontSize: 13,
          fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
        }}
      >
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>
          {node.isDirectory ? (isOpen ? "▾ " : "▸ ") : "  "}
          {node.name}
        </span>
        {statusStyle && (
          <span style={{ flexShrink: 0, color: statusStyle.color, fontWeight: 700, fontSize: 11 }}>
            {statusStyle.label}
          </span>
        )}
      </button>
      {node.isDirectory &&
        isOpen &&
        node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
          />
        ))}
    </div>
  );
}

export default function FilesPane({ cwd, visible }: FilesPaneProps) {
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  // Per-path, not one shared boolean — reselecting an already-open dirty
  // file used to silently clear its unsaved-changes indicator (the header
  // dot disappeared, the Save button went disabled) even though the cached
  // model genuinely still had unsaved edits, since the old single boolean
  // reset unconditionally on every selection change regardless of which
  // file's edits it was actually describing.
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  // Which files have ever been opened, in open order — modelsRef already
  // accumulated these in memory (preserving edits/undo history on
  // reselect), but nothing surfaced that in the UI; see the tab bar below.
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const resolvedTheme = useResolvedTheme();
  const dirty = selectedPath !== undefined && dirtyPaths.has(selectedPath);

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const openPathsRef = useRef(openPaths);
  openPathsRef.current = openPaths;

  const refreshTree = () => {
    void window.metaharnFiles.listTree(cwd).then(setTree);
  };

  useEffect(refreshTree, [cwd]);
  useEffect(() => {
    // FilesPane isn't remounted when switching directly between two
    // projects while already on the "project" view (only `cwd` changes) —
    // the editor-mount effect below already tears down/recreates the
    // editor and disposes every model on cwd change, so this keeps the
    // open-files tab bar and dirty tracking from referencing a previous
    // project's now-disposed models.
    setSelectedPath(undefined);
    setOpenPaths([]);
    setDirtyPaths(new Set());
  }, [cwd]);
  // The pane stays mounted (CSS-toggled) when switching to Overview, so a
  // one-time fetch on cwd change alone meant the tree silently drifted out
  // of sync with disk the moment an agent in an adjacent terminal created,
  // deleted, or renamed anything — refetch every time this tab is actually
  // shown again, not just on first load.
  useEffect(() => {
    if (visible) refreshTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshTree closes over cwd, which is already a dep of the effect above
  }, [visible]);

  const save = () => {
    const model = editorRef.current?.getModel();
    const path = selectedPathRef.current;
    if (!model || !path) return;
    void window.metaharnFiles.writeFile(cwd, path, model.getValue()).then(() => {
      setDirtyPaths((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    });
  };

  const closeFile = (path: string) => {
    modelsRef.current.get(path)?.dispose();
    modelsRef.current.delete(path);
    setDirtyPaths((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    setOpenPaths((prev) => {
      const idx = prev.indexOf(path);
      const next = prev.filter((p) => p !== path);
      if (selectedPathRef.current === path) {
        const fallback = next[idx] ?? next[idx - 1];
        if (fallback) {
          const fallbackModel = modelsRef.current.get(fallback);
          if (fallbackModel) editorRef.current?.setModel(fallbackModel);
          setSelectedPath(fallback);
        } else {
          editorRef.current?.setModel(null);
          setSelectedPath(undefined);
        }
      }
      return next;
    });
  };

  // Mount the editor once; models get swapped in/out as files are opened.
  useEffect(() => {
    const container = editorContainerRef.current;
    if (!container) return;

    const editor = monaco.editor.create(container, {
      automaticLayout: true,
      theme: resolvedTheme === "dark" ? "vs-dark" : "vs",
      fontSize: 13,
      fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
    });
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);

    return () => {
      editor.dispose();
      for (const model of modelsRef.current.values()) model.dispose();
      modelsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- theme is applied live below, not re-created here
  }, [cwd]);

  useEffect(() => {
    monaco.editor.setTheme(resolvedTheme === "dark" ? "vs-dark" : "vs");
  }, [resolvedTheme]);

  const onToggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const onSelectFile = (relPath: string) => {
    setError(undefined);
    window.metaharnFiles
      .readFile(cwd, relPath)
      .then((content) => {
        const editor = editorRef.current;
        if (!editor) return;
        let model = modelsRef.current.get(relPath);
        if (!model) {
          model = monaco.editor.createModel(content, languageForPath(relPath), monaco.Uri.file(`/${cwd}/${relPath}`));
          model.onDidChangeContent(() => {
            setDirtyPaths((prev) => (prev.has(relPath) ? prev : new Set(prev).add(relPath)));
          });
          modelsRef.current.set(relPath, model);
          setOpenPaths((prev) => [...prev, relPath]);
        }
        editor.setModel(model);
        setSelectedPath(relPath);
        // Deliberately NOT resetting dirty state here — reselecting an
        // already-open file must preserve whatever unsaved edits its
        // cached model already has, not silently clear the indicator.
      })
      .catch((err: Error) => setError(err.message));
  };

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: 220,
          flexShrink: 0,
          borderRight: "1px solid var(--color-border)",
          display: "flex",
          flexDirection: "column",
          background: "var(--color-bg-secondary)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "4px 8px",
            borderBottom: "1px solid var(--color-border)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3, color: "var(--color-text-muted)" }}>
            FILES
          </span>
          <button
            onClick={refreshTree}
            aria-label="Refresh file tree"
            className="metaharn-tooltip"
            style={{
              border: "none",
              background: "transparent",
              color: "var(--color-text-muted)",
              cursor: "pointer",
              fontSize: 13,
              lineHeight: 1,
              padding: "2px 4px",
            }}
          >
            ↻
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 0" }}>
          {tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              expanded={expanded}
              onToggle={onToggle}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {openPaths.length > 0 && (
          <div
            style={{
              display: "flex",
              overflowX: "auto",
              borderBottom: "1px solid var(--color-border)",
              flexShrink: 0,
              background: "var(--color-bg-secondary)",
            }}
          >
            {openPaths.map((path) => {
              const name = path.split("/").pop() ?? path;
              const isSelected = path === selectedPath;
              const isDirty = dirtyPaths.has(path);
              return (
                <div
                  key={path}
                  onClick={() => onSelectFile(path)}
                  title={path}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 8px 6px 12px",
                    fontSize: 12,
                    fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
                    borderRight: "1px solid var(--color-border)",
                    background: isSelected ? "var(--color-bg-elevated)" : "transparent",
                    color: isSelected ? "var(--color-text)" : "var(--color-text-secondary)",
                    cursor: "pointer",
                    flexShrink: 0,
                    maxWidth: 180,
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                  {isDirty && <span style={{ flexShrink: 0, color: "var(--color-accent)" }}>•</span>}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeFile(path);
                    }}
                    aria-label="Close file"
                    className="metaharn-tooltip"
                    style={{
                      flexShrink: 0,
                      border: "none",
                      background: "transparent",
                      color: "var(--color-text-muted)",
                      cursor: "pointer",
                      fontSize: 12,
                      lineHeight: 1,
                      padding: "0 2px",
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "6px 10px",
            borderBottom: "1px solid var(--color-border)",
            fontSize: 12,
            fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
            color: "var(--color-text-secondary)",
            flexShrink: 0,
          }}
        >
          <span>
            {selectedPath ?? "No file open"}
            {dirty ? " •" : ""}
          </span>
          {selectedPath && (
            <button
              onClick={save}
              disabled={!dirty}
              className={dirty ? "metaharn-btn-primary" : undefined}
              style={!dirty ? { border: "1px solid var(--color-border)", borderRadius: 6, background: "transparent", padding: "4px 10px", color: "var(--color-text-muted)" } : { padding: "4px 10px" }}
            >
              Save
            </button>
          )}
        </div>
        {error && (
          <p style={{ color: "var(--color-error)", background: "var(--color-error-soft)", padding: "4px 10px", margin: 0, fontSize: 12 }}>
            {error}
          </p>
        )}
        <div ref={editorContainerRef} style={{ flex: 1, minHeight: 0, background: "var(--color-editor-bg)" }} />
      </div>
    </div>
  );
}
