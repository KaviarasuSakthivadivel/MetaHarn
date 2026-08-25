import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

// Chromium enforces a hard per-page cap on simultaneous WebGL contexts
// (single digits in Electron's embedded GPU process, well below a typical
// browser tab's ~16) — exceeding it doesn't fail gracefully for just the
// new context, it can force-evict and break an EXISTING one. Every open
// terminal tab stays mounted (co-mounted, CSS-hidden) at once in this app,
// and the grid view can additionally mount several more simultaneously
// VISIBLE panes — both real, reproduced ways to exceed the cap, which
// showed up as terminals going blank/unresponsive after adding WebGL.
// Module-level and shared across every TerminalPane instance in this
// renderer process, so it's a real budget, not a per-instance guess.
// Conservative on purpose: a slightly-slower-to-scroll pane beyond the cap
// is a far better outcome than a frozen one.
let activeWebglContexts = 0;
const MAX_WEBGL_CONTEXTS = 4;
import { useResolvedTheme, useSettings } from "./SettingsContext.js";
import { getTheme, DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from "./themes.js";

interface TerminalPaneProps {
  cwd: string;
  /** MetaHarn's own terminal-session catalog id. The main process resolves
   * which real CLI agent this runs and what to resume/launch from this id
   * alone (see agents/registry.ts) — TerminalPane itself stays agent-
   * agnostic. Calling metaharnPty.create with an id that already has a live
   * pty just reattaches to it — switching tabs never kills anything. */
  terminalSessionId: string;
  /** Fires once, with the first non-empty line the user types (Enter to
   * Enter) — used to auto-title a brand-new terminal session the same way
   * a chat session's title falls back to its first message. Only pass this
   * for a genuinely new session; a reopened one should keep its title. */
  onFirstInput?: (line: string) => void;
  /** Re-focuses the terminal whenever this flips to true — it stays mounted
   * (CSS-toggled) when switching away to the Files tab, so without this the
   * terminal would only ever get keyboard focus once, at creation. */
  visible?: boolean;
  /** Fires when the underlying pty process exits — including while this
   * tab is hidden/inactive, since the component (and its onExit listener)
   * stays mounted for the whole open-tab lifetime regardless of which tab
   * is currently visible. Lets App.tsx track per-tab liveness for the tab
   * strip's status dot, distinct from just writing the exit line into this
   * instance's own (possibly off-screen) xterm buffer. */
  onProcessExit?: () => void;
}

export default function TerminalPane({ cwd, terminalSessionId, onFirstInput, visible, onProcessExit }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // Read inside the ResizeObserver callback below, which is created once in
  // the mount effect and would otherwise close over whichever `visible` was
  // current at mount time — same stale-closure-avoidance pattern used
  // elsewhere in this app (see App.tsx's viewRef).
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const { terminalFontSize, darkThemeId, lightThemeId } = useSettings();
  const resolvedTheme = useResolvedTheme();
  // xterm.js renders to canvas, not DOM — CSS custom properties never reach
  // it, so it needs the active named theme's own explicit ANSI palette.
  const activeThemeId = resolvedTheme === "dark" ? darkThemeId : lightThemeId;
  const xtermTheme =
    getTheme(activeThemeId)?.terminal ??
    getTheme(resolvedTheme === "dark" ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID)!.terminal;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: terminalFontSize,
      fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
      theme: xtermTheme,
    });
    termRef.current = term;
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(container);

    // xterm's default renderer redraws every visible row as DOM elements —
    // fine for light output, but scrolling/redraw visibly lags under real
    // agent-CLI output volume (long tool output, fast-scrolling logs). The
    // WebGL renderer draws to a GPU-composited canvas instead — same visual
    // result, much cheaper to scroll. Only attempted under the shared
    // MAX_WEBGL_CONTEXTS budget above; past it, this pane just keeps the
    // default DOM renderer, same as before WebGL support existed. `disposed`
    // guards against double-decrementing the shared counter — context loss
    // (a real, possible event later, e.g. the GPU process itself resetting)
    // and this effect's own unmount cleanup can each trigger disposal, but
    // only the first one should give back a budget slot.
    let webglAddon: WebglAddon | null = null;
    let webglDisposed = true;
    if (activeWebglContexts < MAX_WEBGL_CONTEXTS) {
      try {
        webglAddon = new WebglAddon();
        activeWebglContexts++;
        webglDisposed = false;
        webglAddon.onContextLoss(() => {
          webglAddon?.dispose();
          if (!webglDisposed) {
            webglDisposed = true;
            activeWebglContexts--;
          }
        });
        term.loadAddon(webglAddon);
      } catch {
        // WebGL2 unavailable in this environment — default DOM renderer
        // stays in effect, same as before this change existed.
        webglAddon = null;
        webglDisposed = true;
      }
    }

    fitAddon.fit();
    term.focus();

    // metaharn:ptyData/ptyExit are pushed on one shared channel for the whole
    // window, and every open tab's TerminalPane stays mounted (hidden, not
    // unmounted) at once now — so every instance's onData callback fires for
    // EVERY session's events, not just its own. terminalSessionId is the
    // real filter (this instance's own, stable prop); ptyId is a secondary
    // guard against React StrictMode's dev-mode double-invoke (mount,
    // cleanup, mount again) landing a stale pty's events on a listener that
    // outlived it.
    const activePtyIdRef = { current: -1 };

    const unsubData = window.metaharnPty.onData(({ ptyId, terminalSessionId: forSession, data }) => {
      if (forSession === terminalSessionId && ptyId === activePtyIdRef.current) term.write(data);
    });
    const unsubExit = window.metaharnPty.onExit(({ ptyId, terminalSessionId: forSession, exitCode }) => {
      if (forSession === terminalSessionId && ptyId === activePtyIdRef.current) {
        term.write(`\r\n[process exited with code ${exitCode}]\r\n`);
        onProcessExit?.();
      }
    });

    void window.metaharnPty.create(cwd, terminalSessionId).then(({ ptyId, scrollback }) => {
      // Order matters: write replayed scrollback BEFORE this instance starts
      // accepting live metaharn:ptyData events (activePtyIdRef gates that) —
      // reattaching to an already-running pty (a second grid instance, a
      // reopened tab) otherwise mounts a genuinely empty xterm buffer that
      // only shows output written after this exact moment. If the CLI on
      // the other end was just idling at its own prompt, nothing new ever
      // arrives and the pane looks permanently blank/stuck even though the
      // real process is fine — see pty-ipc.ts's scrollback buffer.
      if (scrollback) term.write(scrollback);
      activePtyIdRef.current = ptyId;
      if (visibleRef.current !== false) void window.metaharnPty.resize(terminalSessionId, term.cols, term.rows);
    });

    // Buffers the user's first typed line (Enter to Enter) to auto-title a
    // brand-new terminal session — a rough heuristic, not a real terminal
    // parser: escape sequences (arrow keys, etc.) are skipped wholesale
    // rather than interpreted, since xterm.js's onData delivers each key
    // event as one complete chunk. Stops tracking after the first non-empty
    // line either way, so it never fires twice.
    let firstLineBuffer = "";
    let firstLineDone = !onFirstInput;

    const dataDisposable = term.onData((data) => {
      void window.metaharnPty.write(terminalSessionId, data);

      if (firstLineDone) return;
      if (data.startsWith("\x1b")) {
        // escape sequence (arrow keys, etc.) — not typed text, ignore
      } else if (data === "\r" || data === "\n") {
        const line = firstLineBuffer.trim();
        if (line) {
          firstLineDone = true;
          onFirstInput?.(line);
        }
      } else if (data === "\x7f" || data === "\b") {
        firstLineBuffer = firstLineBuffer.slice(0, -1);
      } else if (data.charCodeAt(0) >= 0x20) {
        firstLineBuffer += data;
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      // A hidden (display:none) tab's container has zero size — fitting
      // against that would compute garbage. The [visible] effect below
      // re-fits and re-syncs the real size the instant this tab is shown
      // again, so skipping here loses nothing.
      if (visibleRef.current === false) return;
      fitAddon.fit();
      void window.metaharnPty.resize(terminalSessionId, term.cols, term.rows);
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      unsubData();
      unsubExit();
      if (!webglDisposed) {
        webglDisposed = true;
        activeWebglContexts--;
      }
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- font size/theme are applied live below, not re-created here;
    // terminalSessionId/onFirstInput/onProcessExit are read once at mount, which is safe because App.tsx gives each
    // open tab a stable key (its terminalSessionId) for the tab's whole *open* lifetime — this effect
    // only re-runs on a genuine close+reopen, never on switching which tab is merely visible, since
    // switching no longer changes this component's key (see App.tsx's openTerminalTabs rendering).
  }, [cwd]);

  // Live-update an already-open terminal's look without tearing down the pty.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = terminalFontSize;
    term.options.theme = xtermTheme;
    if (visible !== false) fitAddonRef.current?.fit();
  }, [terminalFontSize, xtermTheme, visible]);

  useEffect(() => {
    // A tab that stayed mounted-but-hidden through a window resize needs to
    // re-sync its real dimensions the instant it's shown again — a resize
    // that fired while display:none was skipped above (garbage measurement).
    if (!visible) return;
    const term = termRef.current;
    term?.focus();
    fitAddonRef.current?.fit();
    if (term) void window.metaharnPty.resize(terminalSessionId, term.cols, term.rows);
  }, [visible, terminalSessionId]);

  return (
    // xterm renders flush against its container with zero padding of its own
    // (real terminal semantics — text starts at column 0) — this outer div
    // is purely cosmetic breathing room around that, not something xterm
    // knows about. Its own background matches the active theme's terminal
    // background (not the app's chrome background) so the padding reads as
    // margin inside one continuous terminal surface, not a mismatched frame
    // around it. fitAddon/ResizeObserver measure the INNER div, so they
    // already see the correctly-shrunk (post-padding) size for free — no
    // resize-logic changes needed for this.
    <div style={{ width: "100%", height: "100%", padding: 12, boxSizing: "border-box", background: xtermTheme.background }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
