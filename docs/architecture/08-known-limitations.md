# Known limitations

Open architectural gaps, in rough order of "will bite you first." Each entry says what's true today, why, and what a real fix looks like — read this before extending the system so you don't rediscover something already known, and update it the moment one of these actually gets fixed.

## Security / correctness

### No sandboxing for agent tool execution

Pi's `bash`, `edit`, and `write` tools operate directly against the real host filesystem — there is no container, VM, or permission gate between "the agent decided to run a command" and it actually running on your machine. Acceptable for a single-user local desktop app where the user is the one giving the agent instructions; **not** acceptable if MetaHarn ever runs multi-tenant or executes on a remote/shared host. Per `docs/PLAN.md`'s Phase 5, real sandboxing (E2B, Firecracker, or similar) is roadmap, not built.

### No multi-tenancy or auth

The schema is `org_id`-shaped everywhere (see [`05-data-model.md`](05-data-model.md)), but there is exactly one implicit `"default"` org, created lazily, and no auth UI at all. Anyone with access to the machine has full access to every project MetaHarn knows about.

### No automated test suite

Every bug found and fixed in this codebase so far (the frozen-main-process indexing bug and `utilityProcess`/onnxruntime crash from the now-removed embeddings indexer, the CODEOWNERS null-byte corruption, a pty-resize `EBADF` crash, a confirm-dialog that silently no-op'd because it was built but never rendered) was found through **live manual reproduction** — running the app, or a standalone harness script, and observing real failures — not through a test suite catching it first. This is a real gap: correctness currently depends on remembering to manually re-verify after changes, not on CI. Worth prioritizing before the codebase grows much further, especially around the IPC contract and the agent-adapter layer, where a silent regression wouldn't necessarily be obvious from the UI.

## Terminal sessions

### Persistence is in-app only — a real pty doesn't survive an app quit

Opening a second terminal session, or navigating away and back, no longer kills the process running in the one you left (see [`02-process-model.md`](02-process-model.md)'s session-keyed pty registry, [`07-frontend.md`](07-frontend.md)'s always-mounted tabs). What this does NOT cover: quitting MetaHarn (or the OS killing it) still kills every live pty, same as before — nothing here serializes a running session to disk or re-spawns it on next launch. Reopening a terminal session after a restart falls back to whatever the underlying CLI's own `--resume` can reconstruct from its transcript, same as it always did; MetaHarn's own raw shell scrollback (as opposed to the agent CLI's transcript) has never survived a restart and still doesn't.

### Gemini's adapter is built from docs, not verified against a real install

Claude Code's adapter (`agents/claude.ts`) is directly verified. Codex's (`agents/codex.ts`) **was** built from docs only and got its stats parsing genuinely wrong on the first pass — real usage confirmed session-id discovery worked, but the transcript's actual JSON schema (`{timestamp, ordinal, type, payload}`, token usage under `event_msg`/`token_count`) turned out completely different from the flatter shape assumed from third-party write-ups. Fixed and now directly verified against a real Codex 0.148.0 transcript — see [`03-agent-runtime.md`](03-agent-runtime.md). Forking is still only self-checked, not exercised end-to-end. Gemini's (`agents/gemini.ts`) goes further and simply doesn't implement discovery/resume/fork/stats at all — its session-storage `project_hash` algorithm is genuinely undocumented anywhere checked, and guessing it was judged worse than shipping a session type that's honestly "live-only" (same lesson Codex's stats bug reinforced: an unverified guess at an undocumented on-disk format is a real risk, not a formality). A Gemini terminal session works like any other while its tab stays open, but can't be resumed after closing the tab or restarting the app, can't be forked, and always shows the context panel's existing "No stats yet" state. Revisit once Gemini CLI can be checked against a real install the same way Codex just was.

### Agent-swap context handoff is best-effort, not a real session transfer

Swapping a terminal session's agent (`AgentSwapMenu.tsx`) tries to carry context forward by asking the outgoing agent to summarize itself and seeding that into the new agent's opening prompt (see [`03-agent-runtime.md`](03-agent-runtime.md)) — there's no native way to transfer an actual conversation between different CLI products, and none is coming. Real limits on this, beyond "it's a summary, not the original context": Gemini can never be a handoff *source* (it has no resumable session at all, see above); Claude's non-interactive summarization flag combination (`-p --resume`) is confirmed from the CLI's own `--help` text but wasn't live end-to-end tested (only Codex's was, against a real session); Gemini-as-*target* seeding (`gemini "<summary>"`) assumes Gemini accepts a positional initial prompt the same way Claude/Codex do, which is unverified since Gemini isn't installed. Every one of these degrades to a plain fresh launch (no seeded context, no error surfaced) if the assumption is wrong — see `generateHandoffSummary`'s contract. Separately, swapping a session *back* to an agent kind it was already running earlier will resume that agent's own still-on-disk history instead of seeding a summary (a real, correct, but easy-to-misread-as-a-bug edge case — the old transcript file is untouched by whatever ran in between).

## Configuration / UX

### Model provider and model ID aren't configurable in-app

`METAHARN_MODEL_PROVIDER` / `METAHARN_MODEL_ID` are `.env`-only. The Settings page displays them read-only, with a note pointing at `.env` — actually changing them from the UI isn't wired up.

### Postgres-via-Docker as a dependency of a "native app"

Flagged since Phase 0/1 (`docs/PLAN.md`): running `docker compose up -d` is a real UX wart for a tool meant to feel like a native desktop app. Acceptable for this dev-machine stage; needs a real answer (bundled Postgres, SQLite+ a vector extension, or a hosted DB) before wider distribution.

### No packaged-build credential storage

Secrets live in `.env` files today. A packaged build would want OS-native secure storage (Keychain on macOS, DPAPI on Windows) instead.

### Windows/Linux distribution not wired up

Only `MakerZIP` for `darwin` is configured in `forge.config.ts`. The Vite-based build structure (main/preload/renderer as independent targets) was deliberately built to make adding Windows/Linux makers later a config addition, not a restructure — but it hasn't been done yet.

### Session tree is a plain outline, not a graph

`SessionTreeView.tsx` is an intentionally simple indented list, not a visual branch graph. The underlying data (`getSessionTree()`) already supports a richer layout — this is a rendering choice, not a data limitation, and low priority to change.

### Monaco doesn't follow the active named theme

`FilesPane.tsx` maps MetaHarn's light/dark *mode* to Monaco's built-in `vs`/`vs-dark` themes, not the specific named theme (Dracula, Nord, etc.) the rest of the app (including the terminal) follows. A real fix means defining a Monaco theme per named MetaHarn theme, the same way `themes.ts` already does for xterm.js's `terminal` palette — a genuine design task (Monaco syntax themes need token-level color rules `themes.ts`'s `vars`/`terminal` data doesn't have), not just a refactor, so it's still not done. The dead `--monaco-theme` CSS var that implied this already existed (nothing ever read it) has been removed rather than left as false signal.

### Chat sessions can't be tabbed and kept warm the way terminal sessions can

`openTerminalTabs` (`App.tsx`) is a real array — N terminal sessions can run live ptys concurrently and be switched between without losing any of them, because `pty-ipc.ts` got a session-keyed pty registry rewrite. Chat sessions have no equivalent: `ipc.ts`'s `sessionsByWindow: Map<number, WindowSession>` holds exactly one live Pi `AgentSession` per *window*, and `metaharn:init` disposes the previous one before creating a new one — so opening a second chat session always replaces the first rather than keeping both warm. Fixing this for real needs a main-process rewrite on the same scale terminals already got (a session-keyed `AgentSession` registry instead of one-per-window), paired with the renderer extracting today's inline chat-session JSX/state in `App.tsx` into its own `ChatSessionPane`-style component per open tab, mirroring `TerminalPane.tsx`. Flagged as a real, scoped-out gap — not attempted alongside the sidebar/design-token work, which was renderer-only and lower-risk.

### `ui.tsx`'s shared primitives aren't retrofitted everywhere

`SPACE`/`TEXT`/`RADIUS` and `Section`/`Row`/`ValueRow`/`Eyebrow`/`SegmentedControl`/`MetaChip` (see [`07-frontend.md`](07-frontend.md)) were applied where a UI audit found concrete, verified drift (`SettingsPage.tsx`, `ContextWindowPanel.tsx`) and in new code built after they existed (`Sidebar.tsx`) — not swept across every other screen's inline styles. `ProjectOverview.tsx`, `ProjectsListPage.tsx`, `App.tsx`'s chat/terminal views, etc. still hand-write their own style objects; nothing stops new drift from accumulating there until (if) they're migrated too.

## Install/build environment quirks (already worked around, documented for context)

This environment blocks native-module `postinstall` scripts by default (an `npm install-scripts` allowlist). One package is affected and already handled:
- `node-pty` — `apps/desktop/scripts/fix-node-pty-permissions.js` (run via `postinstall`) manually `chmod +x`'s its `spawn-helper` binary, since the blocked postinstall would normally do this.

If a future dependency needs its postinstall script to actually run (not just a prebuilt-binary lookup), it'll need either an allowlist change (`npm install-scripts approve <pkg>`, out of this codebase's control) or a fix script following the `fix-node-pty-permissions.js` pattern.

### `sharp` is no longer a dependency — icon regeneration needs it installed manually

`07-frontend.md`'s icon-regeneration pipeline (source SVG → `assets/icon.iconset/*.png` → `.icns`) used `sharp`, previously present only as a transitive dependency of `@huggingface/transformers` (the removed embeddings indexer's model-loading package — see [`04-context-engine.md`](04-context-engine.md)). Removing that package means `sharp` is no longer guaranteed to be in `node_modules`. The committed `.icns`/`.iconset` assets are unaffected (nothing at build or runtime reads `sharp`), but regenerating them after an artwork change now needs `npm install sharp` run manually first — not currently a real dependency anywhere in a `package.json`.
