import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import CommitDiffWindow from "./CommitDiffWindow.js";
import BranchExplorer from "./BranchExplorer.js";
import { SettingsProvider } from "./SettingsContext.js";
// Real, self-hosted font files (Fontsource — bundles the actual .woff2s,
// not a CDN link) — this is an offline-capable desktop app, so the UI must
// never depend on network access to render its own type correctly. Only
// the weights actually used app-wide: 400/500/600 for Plex Sans (body,
// medium emphasis, headings/bold labels), 400/500 for Plex Mono (terminal,
// code, monospace data — see theme.css / TerminalPane.tsx / every inline
// `fontFamily: '"IBM Plex Mono", ...'` for where each is applied).
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./theme.css";

// Chromium's default behavior for a file/folder dropped onto the window is
// to navigate to it (as a file:// URL), which blanks out the whole app.
// There's no legitimate drop target here, so block it globally.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// One renderer bundle, three possible windows — the commit-diff window
// (main.ts's createCommitDiffWindow) and the branch explorer window
// (createBranchExplorerWindow) each load this exact same URL with their own
// `window=...` query param instead of shipping a separate Vite entry point
// per window. Every other window (today, just the main one) has no such
// param and renders the normal app shell.
const params = new URLSearchParams(window.location.search);
const windowKind = params.get("window");

// SettingsProvider wraps every window, not just the main one — it's the
// only thing that reads the user's actual theme choice (light/dark/system,
// which NAMED theme) from localStorage and applies it to `document`. A
// window rendered without it falls back to theme.css's bare defaults and
// raw OS light/dark detection, ignoring whatever theme the user actually
// picked in Settings — a real bug the commit-diff and branch-explorer
// windows both had until this wrap was added here.
createRoot(root).render(
  <StrictMode>
    <SettingsProvider>
      {windowKind === "commitDiff" ? (
        <CommitDiffWindow cwd={params.get("cwd") ?? ""} hash={params.get("hash") ?? ""} />
      ) : windowKind === "branchExplorer" ? (
        <BranchExplorer cwd={params.get("cwd") ?? ""} initialBranch={params.get("branch") ?? undefined} />
      ) : (
        <App />
      )}
    </SettingsProvider>
  </StrictMode>,
);
