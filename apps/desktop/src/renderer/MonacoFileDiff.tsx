import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import "./monacoSetup.js";
import { useResolvedTheme } from "./SettingsContext.js";

// Small, local language map — deliberately not imported from FilesPane.tsx
// (a different concern: its own file-tree/editor language detection, not
// diff-viewing); trimmed to the extensions most likely to show up in a
// diff review, not a full mime-type table.
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

export function languageForPath(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANGUAGE[ext] ?? "plaintext";
}

interface MonacoFileDiffProps {
  oldContent: string | null;
  newContent: string | null;
  path: string;
}

/**
 * Renders one file's before/after with Monaco's real diff editor — the
 * same engine VS Code itself uses, already a MetaHarn dependency (FilesPane.tsx),
 * so this is zero new dependencies rather than a hand-rolled diff renderer.
 * Shared by CommitDiffWindow.tsx (commit vs parent) and GitPanel.tsx's
 * Changes tab (HEAD vs working tree) — deliberately fetches nothing itself;
 * each caller resolves oldContent/newContent from its own git call (a
 * commit's two different `git show`s vs. one `git show` + a real disk read)
 * and only mounts this once content is ready. That keeps this component
 * limited to just the Monaco mount/dispose/theme/sizing lifecycle, which is
 * identical either way, while the fetch strategy — which genuinely differs
 * per caller — stays with the caller.
 */
export default function MonacoFileDiff({ oldContent, newContent, path }: MonacoFileDiffProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [height, setHeight] = useState(240);
  const resolvedTheme = useResolvedTheme();

  useEffect(() => {
    if (!containerRef.current) return;
    const language = languageForPath(path);
    const originalModel = monaco.editor.createModel(oldContent ?? "", language);
    const modifiedModel = monaco.editor.createModel(newContent ?? "", language);
    const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
      readOnly: true,
      renderSideBySide: false,
      automaticLayout: true,
      theme: resolvedTheme === "dark" ? "vs-dark" : "vs",
      fontSize: 13,
      fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
      scrollBeyondLastLine: false,
    });
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    diffEditorRef.current = diffEditor;
    const lineCount = Math.max((oldContent ?? "").split("\n").length, (newContent ?? "").split("\n").length);
    setHeight(Math.min(600, Math.max(160, lineCount * 19 + 20)));
    return () => {
      const editor = diffEditorRef.current;
      if (editor) {
        const model = editor.getModel();
        model?.original.dispose();
        model?.modified.dispose();
        editor.dispose();
        diffEditorRef.current = null;
      }
    };
  }, [oldContent, newContent, path, resolvedTheme]);

  return (
    <div style={{ position: "relative", height, borderTop: "1px solid var(--color-border)" }}>
      <div ref={containerRef} style={{ height: "100%" }} />
    </div>
  );
}
