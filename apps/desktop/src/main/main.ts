import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, nativeImage, shell } from "electron";
import { disposeSessionFor, registerIpcHandlers } from "./ipc.js";
import { disposeAllPtysFor, registerPtyIpcHandlers } from "./pty-ipc.js";
import { startAutomationRuntime, stopAutomationRuntime } from "./automation.js";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

// This file builds as real ESM (see vite.main.config.ts) — __dirname isn't
// a global here the way it is in CJS.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// packagerConfig.icon (forge.config.ts) only applies to a packaged build —
// this is the same artwork used at runtime for dev mode's dock icon (macOS)
// and the BrowserWindow icon (Linux/Windows taskbar; macOS ignores this).
const iconPath = path.join(__dirname, "../../assets/icon.png");

// electron-squirrel-startup's install/uninstall shortcut handling is only
// relevant once the Windows Squirrel maker is wired up (deferred — see
// forge.config.ts) — no need for the guard until then.

const createWindow = () => {
  console.log("[metaharn] creating window, dev server url:", MAIN_WINDOW_VITE_DEV_SERVER_URL);

  const mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    // No separate native title-bar strip — the traffic lights float over our
    // own TopBar (which gets left padding to clear them) instead of
    // reserving a blank OS-chrome bar above it.
    // trafficLightPosition is pinned explicitly rather than left at macOS's
    // default — TopBar.tsx's left padding is set to match this exact,
    // known position instead of guessing at OS-version-dependent placement
    // (an earlier guess left too little clearance).
    title: "",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Electron's default for any window.open() call is to open a *new
  // BrowserWindow* running this same app — not the OS browser. When the
  // call already carries a real URL (e.g. @xterm/addon-web-links' handler),
  // deny it and hand the URL to the real default browser directly. But
  // xterm.js's own *built-in* OSC-8 hyperlink handler (used for real
  // terminal hyperlinks the Claude CLI prints, e.g. artifact links) opens a
  // *blank* window first and only sets its destination a moment later via
  // `.location.href = url` — there's no URL to redirect to yet at this
  // point, so that case has to be let through as a hidden, throwaway
  // window and caught via its navigation instead (below).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url && url !== "about:blank") {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow", overrideBrowserWindowOptions: { show: false } };
  });

  mainWindow.webContents.on("did-create-window", (childWindow) => {
    childWindow.webContents.once("will-navigate", (event, url) => {
      event.preventDefault();
      void shell.openExternal(url);
      childWindow.close();
    });
  });

  mainWindow.webContents.on("did-finish-load", () => console.log("[metaharn] renderer did-finish-load"));
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) =>
    console.error("[metaharn] renderer did-fail-load", { code, desc, url }),
  );
  mainWindow.webContents.on("render-process-gone", (_e, details) =>
    console.error("[metaharn] render-process-gone", details),
  );
  mainWindow.webContents.on("unresponsive", () => console.error("[metaharn] renderer unresponsive"));
  mainWindow.webContents.on("preload-error", (_e, preloadPath, error) =>
    console.error("[metaharn] preload-error", preloadPath, error),
  );
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) =>
    console.log(`[renderer console] (${level}) ${message} @ ${sourceId}:${line}`),
  );

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  const webContentsId = mainWindow.webContents.id;
  mainWindow.on("closed", () => {
    console.log("[metaharn] window closed");
    disposeSessionFor(webContentsId);
    disposeAllPtysFor(webContentsId);
  });
};

/**
 * A second, independent window for viewing one commit's full diff — the
 * user explicitly asked for this to be a real separate window, not another
 * in-app view (unlike Branch Explorer, which IS just another MainView in
 * the main window, since that's a plain full-page navigation, not a
 * "pop this out" request). There's no second Vite entry point for this —
 * it loads the exact same renderer bundle as the main window, and
 * `main.tsx` branches on the `window=commitDiff` query param at startup to
 * render `CommitDiffWindow` instead of the normal `App` shell. A window is
 * just a URL + options, not a separate build artifact.
 */
const createCommitDiffWindow = (cwd: string, hash: string) => {
  const query = `window=commitDiff&cwd=${encodeURIComponent(cwd)}&hash=${encodeURIComponent(hash)}`;

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}?${query}`);
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), { search: query });
  }
};

/**
 * A real second window for the branch/commit browser — originally built as
 * a same-window MainView (a plain full-page navigation), but the user
 * explicitly asked for it to open as its own properly-sized window instead,
 * matching createCommitDiffWindow's pattern exactly (same renderer bundle,
 * a `?window=branchExplorer` query param routed in main.tsx). Sized larger
 * than the commit-diff window (1200×820 vs 1100×760) since this is meant to
 * be the primary "full size" browsing surface, not a secondary popup.
 */
const createBranchExplorerWindow = (cwd: string, branch?: string) => {
  const query = `window=branchExplorer&cwd=${encodeURIComponent(cwd)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`;

  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    title: "",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}?${query}`);
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), { search: query });
  }
};

app.on("render-process-gone", (_e, _wc, details) => console.error("[metaharn] app render-process-gone", details));
app.on("child-process-gone", (_e, details) => console.error("[metaharn] child-process-gone", details));
app.on("before-quit", () => console.log("[metaharn] before-quit"));
app.on("will-quit", () => {
  console.log("[metaharn] will-quit");
  void stopAutomationRuntime();
});
process.on("uncaughtException", (err) => console.error("[metaharn] uncaughtException in main", err));
process.on("exit", (code) => console.log("[metaharn] main process exit", code));

app.whenReady().then(() => {
  console.log("[metaharn] app ready");
  // packagerConfig.icon (forge.config.ts) only takes effect once packaged
  // — without this, dev mode (electron-forge start) shows the generic
  // Electron icon in the Dock regardless of what's configured for packaging.
  if (process.platform === "darwin") {
    app.dock?.setIcon(nativeImage.createFromPath(iconPath));
  }
  registerIpcHandlers();
  registerPtyIpcHandlers();
  // Independent of any window/session — see automation.ts's module doc. Started once here,
  // never per-window, so scheduled tasks keep firing even while every window is closed on
  // macOS (the app itself stays running — see window-all-closed below).
  startAutomationRuntime();
  // Registered here rather than inside ipc.ts's registerIpcHandlers() —
  // createCommitDiffWindow is local to this file, and ipc.ts is imported
  // BY main.ts, so importing main.ts's window-creation back into ipc.ts
  // would be circular. One handler doesn't need its own module.
  ipcMain.handle("metaharn:openCommitDiffWindow", (_event, cwd: string, hash: string) => {
    createCommitDiffWindow(cwd, hash);
  });
  ipcMain.handle("metaharn:openBranchExplorerWindow", (_event, cwd: string, branch?: string) => {
    createBranchExplorerWindow(cwd, branch);
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  console.log("[metaharn] window-all-closed, windows now:", BrowserWindow.getAllWindows().length);
  if (process.platform !== "darwin") app.quit();
});
