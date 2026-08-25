# MetaHarn — a meta-harness for an agentic dev platform

## Addendum: native desktop pivot (Electron)

### Context

Phase 0 + Phase 1 (below) were built and verified as a web app: `apps/api` (Node/TS server embedding Pi over a WebSocket protocol) + `apps/web` (Next.js chat UI). We since decided against a web UI entirely — MetaHarn ships as a **native macOS app first, extended to Windows (and Linux) later**.

This changes the shell, not the core design: the context-grounding work (`packages/context-engine`, the `who_owns` tool, the virtual `AGENTS.md` injection into Pi) and the catalog DB (`packages/db`) are unchanged and reused as-is.

**Shell choice: Electron**, over Tauri and native SwiftUI. The deciding factor: `@earendil-works/pi-coding-agent` is a Node SDK, and Electron's main process *is* Node — it can be imported and run in-process with no sidecar. A repo survey confirmed this is safe: nothing in the agent runtime's dependency tree needs node-gyp compilation; the only native (`.node`) binaries present are N-API (ABI-stable, no rebuild needed) and belong to `pi-tui`'s interactive-terminal code path, which the programmatic `createAgentSession`/`ModelRuntime` path used here never touches. Electron Forge (Vite + TypeScript) ships macOS, Windows, and Linux makers from one codebase, so "extend to Windows later" is a config addition, not a rewrite.

Because the main process can call the agent directly, **the old WebSocket protocol is replaced by Electron IPC** (`ipcMain`/`ipcRenderer` via a `contextBridge` preload, with `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` — the secure default). `apps/api` and `apps/web` were removed; their logic moved into `apps/desktop`.

### Layout

```
apps/desktop/
  forge.config.ts
  vite.main.config.ts / vite.preload.config.ts / vite.renderer.config.ts
  index.html
  src/
    main/
      index.ts   # app lifecycle, BrowserWindow creation
      agent.ts   # createMetaHarnSession — moved from apps/api/src/agent.ts, unchanged
      catalog.ts # ensureOrgAndRepo/recordSession — moved from apps/api/src/catalog.ts, unchanged
      ipc.ts     # ipcMain handlers, replaces server.ts's WS message switch
    preload/
      index.ts   # contextBridge.exposeInMainWorld('metaharn', { init, prompt, steer, followUp, onEvent })
    renderer/
      main.tsx, App.tsx   # same chat UI/state machine as the old apps/web page, ported to the IPC bridge
```

**IPC contract** (direct translation of the old WS protocol): `metaharn:init(repoPath)` creates the session and starts streaming; `metaharn:prompt`/`metaharn:steer`/`metaharn:followUp` drive turns; `metaharn:event` pushes `ready`/`text_delta`/`thinking_delta`/`tool_start`/`tool_end`/`agent_end`/`error` to the renderer — same event shapes as before, same provider-error-surfacing behavior (`session.agent.state.errorMessage` forwarded even when a turn resolves without throwing). One session per window; closing the window disposes it.

**Known gaps, deliberately deferred:** packaged-build credential storage (Keychain/DPAPI) instead of `.env`; Windows/Linux Forge makers and code signing (Forge supports adding these later without restructuring); Postgres-via-Docker as a dependency of a "native app" (real UX wart for eventual distribution, acceptable for this dev-machine stage).

---

## Original Phase 0/1 plan (built and verified; superseded above by the desktop shell)

## Context

The target shape is an "agentic development environment": an agent + a Workspace UI + a living-docs engine, all grounded in institutional context (ownership, architecture rationale, dependencies) so agents make decisions consistent with how a system was actually built, not generic best practices. It's model-agnostic (Claude/Gemini/Codex).

The goal here is to build a similar product as an external, multi-tenant SaaS (not an internal tool for one org). Before designing, we surveyed three agent harnesses (Pi, Omnigent, OpenChamber) to figure out what to build vs. reuse.

**Key finding:** these three don't compete with what's being built here — Pi and Omnigent are *harnesses* (the "run an LLM in a loop with tools" plumbing), and OpenChamber is a *finished product* built on a harness (OpenCode SDK). None of them do institutional-memory grounding — that's the actual differentiator and the whitespace worth spending effort on. So the plan is: **don't reimplement tool-calling/provider-routing/sandboxing — build on Pi's embeddable SDK, and put the real effort into the context/ownership/docs layer.**

Pi was chosen over Omnigent/OpenChamber because:
- It ships an embeddable Node/TypeScript SDK (`@earendil-works/pi-coding-agent`) designed for exactly this ("adapt Pi to your workflows").
- It already has a **virtual context file injection point** (`agentsFilesOverride` on `DefaultResourceLoader`) — this is the hook institutional-memory grounding needs: per-session, we generate a virtual `AGENTS.md` from the context engine and hand it to Pi instead of (or alongside) a real repo file.
- It has multi-provider model routing built in (`ModelRuntime` / `getModel(provider, model)`), which covers the "model-agnostic" requirement for free.
- Omnigent gives more for free (sandboxing, Slack/mobile) but is a mixed Python+Node stack and opinionated toward multi-agent debate, which isn't what this product needs. OpenChamber is closer to a finished competitor than infrastructure to build on.

## Full roadmap (phased)

0. **Foundations** — TypeScript monorepo, Postgres+pgvector, multi-tenant schema from day one (org_id everywhere), local dev via docker-compose.
1. **Context-aware agent (walking skeleton)** — embed Pi, inject basic institutional context (README/CODEOWNERS/manifest/git log) via `agentsFilesOverride`, minimal chat UI. Proves the core loop end-to-end. **This is what we built first.**
2. **Real context engine** — GitHub App integration, tree-sitter code indexing + embeddings (Voyage AI) into pgvector, ownership/dependency graph, ADR/doc ingestion, exposed to the agent as custom Pi tools (`search_context`, `who_owns`, `get_related_docs`). *(The embeddings/indexing/`search_context` slice of this WAS built, then removed — real usage data showed it going essentially unused next to the always-on Phase 1 context doc. See [`docs/architecture/04-context-engine.md`](architecture/04-context-engine.md). `who_owns` and the GitHub App/ownership-graph/doc-ingestion pieces remain roadmap.)*
3. **Living documentation engine** — after each session/PR, summarize and update versioned docs tied to code paths.
4. **Workspace/portal UI** — dashboard of sessions/work items/docs, session replay (via Pi's `SessionManager.list`/`continueRecent`), integrations settings.
5. **Multi-tenant hardening** — auth (Clerk/WorkOS), per-org isolated session storage, **real sandboxing** (Pi's `bash`/`edit`/`write` tools touch the real filesystem — production multi-tenant use needs each session's tools running inside an isolated container/microVM, e.g. E2B or Firecracker, not the host), billing (Stripe), secrets vault, audit logs.
6. **Model-agnostic polish** — mostly UI/settings on top of Pi's existing `ModelRuntime` abstraction: let each org configure/scope providers and credentials.

Phases 2-6 are roadmap, not yet built — each is its own future planning/build cycle.

## What was built first: Phase 0 + Phase 1 (walking skeleton)

**Monorepo layout (npm workspaces — pnpm/corepack weren't available in the dev environment, npm workspaces give the same structure):**
```
metaharn/
  docs/
    PLAN.md
  apps/
    api/             # Node/TS backend embedding Pi SDK, WebSocket session streaming
    web/              # Next.js (App Router) — minimal chat UI
  packages/
    context-engine/   # v0: local repo context extraction
    db/                # Drizzle schema + migrations (Postgres, org_id from day one)
  docker-compose.yml  # postgres (pgvector image)
```

**apps/api — agent runtime:**
- `@earendil-works/pi-coding-agent` embedded directly.
- Per session: `ModelRuntime.create()` + `createAgentSession({ modelRuntime, sessionManager: SessionManager.create(repoPath), resourceLoader, customTools })`.
- `resourceLoader = new DefaultResourceLoader({ agentsFilesOverride: ... })` injects a virtual `AGENTS.md` built by the context engine.
- Custom tool `who_owns(path)` reads `CODEOWNERS` and returns the owning team/person, proving the tool-call path end to end.
- WebSocket endpoint forwards `session.subscribe` events (text deltas, tool execution) to the client.

**packages/context-engine — v0 context extraction:**
- `buildContextDoc(repoPath)` walks the repo and assembles a single markdown doc from: directory tree, `README.md`, `CODEOWNERS`, `package.json`, last ~20 `git log` entries.
- Deliberately simple — no embeddings/RAG yet (that's Phase 2).

**apps/web — minimal chat UI:**
- Single Next.js page: repo path input + chat panel streaming over WebSocket. No auth/multi-tenant UI yet.

**packages/db:**
- Drizzle schema with `orgs`, `repos`, `sessions` tables (org_id foreign key everywhere) even though Phase 1 only ever uses one implicit org — avoids a schema rewrite in Phase 5.

## Verification

1. `docker compose up -d` (Postgres with pgvector).
2. `npm install`, run migrations (`npm run db:migrate`).
3. `npm run dev:api` and `npm run dev:web`.
4. In the web UI, point at a local git repo that has a `CODEOWNERS` file and a `README.md`.
5. Ask the agent two things:
   - A question only answerable from injected context (e.g. "who owns `path/to/file`, and use the tool to confirm") — confirm the transcript shows a tool execution for `who_owns` and the answer matches the real `CODEOWNERS` entry.
   - A general repo question (e.g. "what does this project do") — confirm the answer reflects the actual `README.md` content, not a generic response.
6. Confirm session persistence: restart `apps/api`, list sessions for that repo path, and verify the prior transcript is recoverable.
