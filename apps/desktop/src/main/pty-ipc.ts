import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { spawnPty, type PtyHandle } from "./pty.js";
import { getAdapter, resolveExternalSessionId } from "./agents/registry.js";
import { getSessionById, setExternalSessionId } from "./catalog.js";

interface PtyEntry {
  ptyId: number;
  term: PtyHandle;
  webContentsId: number;
  /** Everything this pty has written since it spawned, capped at
   * SCROLLBACK_CAP_BYTES. The ONLY thing that made "terminals stuck" in the
   * grid view (blank pane, sometimes just a lone cursor, forever) was this
   * buffer not existing: term.onData is wired up once, at spawn, and pushes
   * live bytes to whichever renderer webContents owned that spawn — a
   * TerminalPane instance mounted later (grid's own second instance for an
   * already-open session; also a closed-then-reopened tab) starts with a
   * genuinely empty xterm buffer and only receives bytes written AFTER it
   * mounted. If the underlying CLI was just sitting idle at its own prompt
   * (nothing NEW to write), that pane stayed blank indefinitely — not
   * broken, just never fed anything to render. Replaying this on every
   * attach (see ptyCreate below) fixes it for every reattach path, not only
   * the grid. */
  scrollback: string;
}

// Comfortably covers a full screen plus real scrollback (xterm's own default
// is 1000 lines) without holding unbounded memory for a long-lived session.
const SCROLLBACK_CAP_BYTES = 200_000;

// Keyed by MetaHarn's own terminal-session catalog id, NOT by window — a pty
// stays alive for as long as its session is "open" in the renderer
// (tab-strip open, not just the currently-viewed one), surviving in-app
// navigation between sessions/tabs. This is the actual fix for switching
// sessions killing whatever was running in the one you switched away from:
// the old one-pty-per-window map forced a kill+respawn on every switch.
//
// Explicitly NOT covered: surviving a full app quit/relaunch. Nothing here
// serializes a live session to disk or re-spawns it on next launch — see
// docs/architecture/08-known-limitations.md.
const ptyBySessionId = new Map<string, PtyEntry>();
let nextPtyId = 1;

// One-shot, in-memory only — relevant for exactly the next metaharn:ptyCreate
// call for a given session id, never needs to survive an app restart, so
// no schema migration for it (see ipc.ts's swapTerminalSessionAgent
// handler, the only writer). Read-and-deleted the moment ptyCreate spawns.
const pendingSeedPrompts = new Map<string, string>();

/** Set right after an agent swap generates a handoff summary (see
 * agents/handoff.ts) — the next ptyCreate for this session id launches
 * with it as the new agent's opening prompt instead of a bare launch. */
export function setPendingSeedPrompt(terminalSessionId: string, prompt: string) {
  pendingSeedPrompts.set(terminalSessionId, prompt);
}

function pushEvent(sender: WebContents, channel: string, payload: unknown) {
  if (!sender.isDestroyed()) sender.send(channel, payload);
}

/** Explicit user-initiated close (tab-strip ×) — distinct from navigating
 * away, which must NOT kill anything. */
export function closePty(terminalSessionId: string) {
  const entry = ptyBySessionId.get(terminalSessionId);
  if (!entry) return;
  entry.term.kill();
  ptyBySessionId.delete(terminalSessionId);
}

/** Every pty a given window owns — called when that window closes. */
export function disposeAllPtysFor(webContentsId: number) {
  for (const [sessionId, entry] of ptyBySessionId) {
    if (entry.webContentsId === webContentsId) {
      entry.term.kill();
      ptyBySessionId.delete(sessionId);
    }
  }
}

/**
 * Codex (and, in principle, any future adapter that can't be told its
 * session id upfront) only reveals its real id once it's written a
 * transcript file — which only happens after the user actually sends a
 * first prompt, not at process spawn. A single fixed-delay guess would
 * usually fire before that's happened, so this polls a few times over
 * ~30s instead, bailing early on success or if the pty already exited.
 * Discovery is also retried on-demand elsewhere (see ipc.ts's stats/fork
 * handlers) for the case where even this polling window isn't enough.
 */
function scheduleDiscovery(terminalSessionId: string, cwd: string, agentKind: string, sinceMs: number) {
  const adapter = getAdapter(agentKind as Parameters<typeof getAdapter>[0]);
  if (!adapter.discoverExternalSessionId) return;

  let attempts = 0;
  const tick = async () => {
    attempts++;
    if (!ptyBySessionId.has(terminalSessionId)) return; // pty closed/exited — stop
    const found = await adapter.discoverExternalSessionId!({ cwd, sinceMs });
    if (found) {
      await setExternalSessionId(terminalSessionId, found);
      return;
    }
    if (attempts < 10) setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}

export function registerPtyIpcHandlers() {
  ipcMain.handle("metaharn:ptyCreate", async (event: IpcMainInvokeEvent, cwd: string, terminalSessionId: string) => {
    const existing = ptyBySessionId.get(terminalSessionId);
    // Already alive — reattach, don't touch the process. Synchronous from
    // here (no await before returning): a pty 'data' event physically can't
    // interleave with this handler mid-flight (both run on the same main-
    // process event loop), so the scrollback snapshot below is exactly
    // "everything up to this reply" — nothing can be dropped or duplicated
    // between it and the live metaharn:ptyData events that follow.
    if (existing) return { ptyId: existing.ptyId, scrollback: existing.scrollback };

    const sender = event.sender;
    const session = await getSessionById(terminalSessionId);
    if (!session) throw new Error(`Unknown terminal session: ${terminalSessionId}`);

    const agentKind = session.agentKind as Parameters<typeof getAdapter>[0];
    const externalId = resolveExternalSessionId({
      agentKind,
      id: session.id,
      externalSessionId: session.externalSessionId,
    });

    const seedPrompt = pendingSeedPrompts.get(terminalSessionId);
    pendingSeedPrompts.delete(terminalSessionId);

    const ptyId = nextPtyId++;
    const term = spawnPty(cwd, agentKind, terminalSessionId, externalId, seedPrompt);
    const entry: PtyEntry = { ptyId, term, webContentsId: sender.id, scrollback: "" };
    ptyBySessionId.set(terminalSessionId, entry);

    term.onData((data) => {
      entry.scrollback = (entry.scrollback + data).slice(-SCROLLBACK_CAP_BYTES);
      pushEvent(sender, "metaharn:ptyData", { ptyId, terminalSessionId, data });
    });
    term.onExit(({ exitCode, signal }) => {
      pushEvent(sender, "metaharn:ptyExit", { ptyId, terminalSessionId, exitCode, signal });
      if (ptyBySessionId.get(terminalSessionId)?.ptyId === ptyId) ptyBySessionId.delete(terminalSessionId);
    });

    if (!externalId) scheduleDiscovery(terminalSessionId, cwd, agentKind, Date.now());

    return { ptyId, scrollback: "" };
  });

  ipcMain.handle("metaharn:ptyWrite", (_event: IpcMainInvokeEvent, terminalSessionId: string, data: string) => {
    ptyBySessionId.get(terminalSessionId)?.term.write(data);
  });

  ipcMain.handle(
    "metaharn:ptyResize",
    (_event: IpcMainInvokeEvent, terminalSessionId: string, cols: number, rows: number) => {
      if (cols <= 0 || rows <= 0) return;
      const term = ptyBySessionId.get(terminalSessionId)?.term;
      if (!term) return;
      try {
        term.resize(cols, rows);
      } catch {
        // The renderer's ResizeObserver can fire a resize just as the
        // process exits (or right after kill()) — the pty's fd is already
        // gone by the time this runs, and node-pty's ioctl throws EBADF
        // rather than failing gracefully. Harmless to ignore: a dead
        // terminal doesn't need resizing.
      }
    },
  );

  ipcMain.handle("metaharn:ptyClose", (_event: IpcMainInvokeEvent, terminalSessionId: string) => {
    closePty(terminalSessionId);
  });
}
