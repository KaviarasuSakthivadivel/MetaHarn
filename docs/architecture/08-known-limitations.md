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

### Pi's model provider and model ID aren't configurable in-app

`METAHARN_MODEL_PROVIDER` / `METAHARN_MODEL_ID` (Pi's own config) are `.env`-only. The
Settings page's "Model" section displays them read-only, with a note pointing at `.env` —
actually changing them from the UI isn't wired up. This is Pi-specific: the separate "Owned
Engine" section further down the same Settings page (see [`09-owned-engine.md`](09-owned-engine.md))
DOES let you change the owned engine's default model and provider keys from the UI — the two
backends' configs are independent and this gap applies only to the Pi one.

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

## Owned engine / OpenWorker surface (see `09-owned-engine.md`)

### The HITL Inbox is wired and discoverable; `buttons.ts` still isn't

`hitl/inbox.ts` is now wired on both surfaces, including a cross-session Inbox page (bell icon
+ pending-count badge, both surfaces) — see [`09-owned-engine.md`](09-owned-engine.md) for the
full writeup, including two real bugs (both caught before shipping, not after): persisting only
on turn-completion meant a durable approval row could survive a restart while the conversation
it belonged to didn't, since a suspended-on-approval turn never reaches its own completion-time
persist — fixed by persisting eagerly the moment a `permission_required` event fires. `buttons.ts`
(rich button-prompt encoding for a mirrored surface like Slack) is still unused — no such
surface exists here, and nothing in this codebase is expected to need it until one does.

### Provider parity is 10, not ~19

`@metaharn/engine`'s `ProviderRouter` has real clients for `anthropic`, `openai`, `ollama`,
`openrouter`, `together`, `fireworks`, `deepseek`, `groq`, `mistral`, and `xai` — every one
but `anthropic` is `OpenAIProvider` pointed at that vendor's own documented OpenAI-compatible
endpoint (`providers.ts`'s `PROVIDER_CATALOG`; no per-vendor SDK code). OpenWorker's own
reference Settings > Models page lists ~19 (also Bedrock, Kimi, MiniMax, Qwen, Vertex,
Volcengine, Z AI/GLM, and a few others), most of them behind auth flows genuinely different
from an API key + base URL (Bedrock/Vertex are cloud-IAM-credentialed, not key-based). Settings
> Models on both surfaces intentionally shows cards **only** for providers that actually
work — no placeholder/fake cards for the rest — so closing the remaining gap means either a
real non-OpenAI-compatible client implementation, or confirming a given vendor's endpoint
really is OpenAI-compatible before adding it to the catalog (not assumed — the base URLs
already in the catalog are each vendor's own published one, but none were live-tested against
a real account in this pass; no keys were on hand for most of them).

### Automation storage is separate per surface, on purpose

Electron's `automation.db` (`app.getPath("userData")`) and `apps/server`'s `automations.db`
(`~/.metaharn`) are two independent `TaskStore`s — a task created in one surface does not
appear in, or run from, the other. Same reasoning as the Postgres-catalog gap below: no shared
store between the two processes exists yet.

### No packaged Tauri build

`apps/web/src-tauri` only runs via `tauri dev` (its `beforeDevCommand` starts both
`@metaharn/server` and the Vite dev server). A real `tauri build` has no dev server to point
at — `@metaharn/server` would need to ship as an actual sidecar binary (Tauri's sidecar
mechanism, typically via `pkg`/`nexe` to produce a real executable, since sidecars are plain
binaries, not "run this with node"). Not attempted in this pass; see `src-tauri/src/lib.rs`'s
module doc.

### Electron's Connectors panel has no enable/disable toggle

Noticed while giving the panel's Remove action an icon-hover treatment to match web (see
[`09-owned-engine.md`](09-owned-engine.md)): every connector Electron saves is hardcoded
`enabled: true` — there's no UI (or wiring) to disable one without deleting it outright. Web's
Connectors page has this (a real toggle switch, wired to `putMcpServer`'s `enabled` field, which
Electron's own `OwnedMcpServer` type already carries). Left as a disclosed gap rather than added
silently, since it's new capability beyond what was asked for in that pass.

### Web-only: dedicated provider pages and curated models

Built for web specifically (see [`09-owned-engine.md`](09-owned-engine.md)) — matching a set of
OpenWorker reference screenshots that were themselves web-style UI. Electron's Models/
Connectors/Automations panels still show the older flat-list layout with a free-text model-id
field, no curated per-provider catalog. Not attempted in this pass — a real port needs its own
design pass for Electron's denser `ListRow`-based settings layout, not a straight copy of web's
card grid.

### No composer's model-picker (built, verified, then removed on request)

A live in-chat model switcher existed briefly — a persisted "enabled models" list, a checkbox
per model, and a chat-header dropdown calling `Engine.switchModel()` (itself still a real,
working method in `packages/engine`, just with no caller from either app again now). Built and
verified working end to end, then explicitly asked to be rolled back; reverted in full rather
than left disabled-but-present, so there's no half-wired feature to trip over later. See
[`09-owned-engine.md`](09-owned-engine.md) for exactly what came out.

### Owned-engine message-level branching, including an inline entry point

Closed across two passes — see [`09-owned-engine.md`](09-owned-engine.md) for the full
writeups, including three real bugs found and fixed while building it: a branch silently
losing its own lineage on resume, a tree-graft placement bug for a branch-of-a-branch, and (for
the inline entry point) the discovery that the chat UI's rendered message list and the
server's raw `ChatMessage[]` aren't in a stable 1:1 correspondence, fixed by threading real
message indices through `@metaharn/engine`'s own event stream rather than guessing client-side.
Both surfaces reconstruct and expose the actual tree a session belongs to
(`getSessionTree()`/`getOwnedSessionTree()`), can branch from ANY message in it via the Tree
panel (Electron reuses Pi's own `SessionTreeView.tsx` unmodified; web got a new
`SessionTree.tsx`), and now also have a "⎇ branch from here" button directly on qualifying chat
messages, live, without needing to open the tree at all. Electron's sidebar still doesn't
render a "forked from"/"branched from" indicator for owned-engine sessions even though
`parentId` is in `SessionListItem` (the web sidebar does show it) — unchanged from these
passes, a sidebar-rendering gap rather than a branching one. Context/token-usage stats and
workspace-trust gating on the MCP config are wired on both surfaces — see
[`09-owned-engine.md`](09-owned-engine.md).

### Web-only: Session panel (Progress checklist, multi-folder Access, collapsed step trace)

Built for web specifically, matching another set of OpenWorker reference screenshots — see
[`09-owned-engine.md`](09-owned-engine.md) for the full writeup, including a real
permission-engine bug (`web_search` permanently stuck requesting approval despite declaring
`requiresApproval: false`, because the egress-risk check only knew how to resolve a `url`
argument) found and fixed while building it. Electron has none of this: no `SessionPanel`
equivalent, no Progress checklist, no in-UI folder grant/revoke (Electron's owned-engine sessions
are still single-workspace, permission-engine roots aside from the implicit workspace/scratch
pair are only reachable by editing config), and no collapsed step trace (Electron's transcript
still renders every tool call as its own top-level row). A real port needs its own layout pass —
Electron has no existing right-hand-sidebar pattern to slot this into, unlike the provider-pages
work which reused an existing settings-page shape.

## Install/build environment quirks (already worked around, documented for context)

This environment blocks native-module `postinstall` scripts by default (an `npm install-scripts` allowlist). One package is affected and already handled:
- `node-pty` — `apps/desktop/scripts/fix-node-pty-permissions.js` (run via `postinstall`) manually `chmod +x`'s its `spawn-helper` binary, since the blocked postinstall would normally do this.

If a future dependency needs its postinstall script to actually run (not just a prebuilt-binary lookup), it'll need either an allowlist change (`npm install-scripts approve <pkg>`, out of this codebase's control) or a fix script following the `fix-node-pty-permissions.js` pattern.

### `sharp` is no longer a dependency — icon regeneration needs it installed manually

`07-frontend.md`'s icon-regeneration pipeline (source SVG → `assets/icon.iconset/*.png` → `.icns`) used `sharp`, previously present only as a transitive dependency of `@huggingface/transformers` (the removed embeddings indexer's model-loading package — see [`04-context-engine.md`](04-context-engine.md)). Removing that package means `sharp` is no longer guaranteed to be in `node_modules`. The committed `.icns`/`.iconset` assets are unaffected (nothing at build or runtime reads `sharp`), but regenerating them after an artwork change now needs `npm install sharp` run manually first — not currently a real dependency anywhere in a `package.json`.
