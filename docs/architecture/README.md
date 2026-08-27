# MetaHarn Architecture

This directory is the technical map of MetaHarn: how the pieces fit together, why they're shaped the way they are, and where the sharp edges currently are. It documents the system **as built**, not the roadmap — for the phased roadmap and the reasoning behind major pivots (native desktop over web, Electron over Tauri, Pi over building a harness from scratch), see [`docs/PLAN.md`](../PLAN.md).

## Start here

For the full system at a glance — every process, both products, and exactly what protocol
connects each pair — see [`00-system-map.md`](00-system-map.md) first. The rest of this page
introduces the core meta-harness concept that `01-overview.md` onward covers in depth.

MetaHarn is a **meta-harness**: it does not implement its own agent loop, tool-calling, or model routing. It embeds [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`) as the execution engine and layers two things on top of it:

1. **Institutional-memory context grounding** — the actual differentiator. Pi gets told *who owns what* (CODEOWNERS) and *what this codebase actually is* (semantic search over the real repo, plus a generated summary doc), instead of relying on the model's generic priors.
2. **A native Workspace UI** — projects, sessions, a session tree/branch view, an integrated terminal, and a file editor, wrapped around Pi's session model.

If you've read agentic-coding-tool architecture docs before (Claude Code, Cursor, Devin, etc.), the shape here is deliberately the same family: an **agent loop** (owned by Pi), a **tool surface** (Pi's built-ins + MetaHarn's custom tools), a **context/memory layer** (MetaHarn's contribution), and a **process/security model** (Electron's contribution). Each has its own document below.

## Map

| Doc | Covers |
|---|---|
| [`00-system-map.md`](00-system-map.md) | **Start here for the full picture.** Every process across both products (`apps/desktop` and `apps/server`+`apps/web`), a complete communication/protocol map between them, and how their state trees stay separate |
| [`01-overview.md`](01-overview.md) | What MetaHarn is, the meta-harness concept, goals and explicit non-goals |
| [`02-process-model.md`](02-process-model.md) | Electron's multi-process architecture: main, preload, renderer, and terminal pty child processes |
| [`03-agent-runtime.md`](03-agent-runtime.md) | Pi SDK integration: session lifecycle, custom tools, event streaming, session tree/branching |
| [`04-context-engine.md`](04-context-engine.md) | Institutional-memory grounding: CODEOWNERS, the generated context doc |
| [`05-data-model.md`](05-data-model.md) | Postgres schema (catalog + session dependencies), and the split between MetaHarn's DB and Pi's own session storage |
| [`06-ipc-contract.md`](06-ipc-contract.md) | Every IPC channel, the three preload bridges, and the security model behind them |
| [`07-frontend.md`](07-frontend.md) | Renderer navigation model, component map, theming |
| [`08-known-limitations.md`](08-known-limitations.md) | Open architectural gaps and tech debt — read this before extending the system |
| [`09-owned-engine.md`](09-owned-engine.md) | `@metaharn/engine` — the second, MetaHarn-owned chat backend (providers, tools, permissions, memory, MCP, automation) and its two surfaces: Electron (`apps/desktop`) and the OpenWorker-shaped local server + web/Tauri UI (`apps/server`, `apps/web`) |

## Keeping this current

**This documentation is expected to be updated whenever the architecture it describes changes** — a new IPC channel, a new tool, a schema change, a new process, a changed data flow. It should also be updated after any conversation that meaningfully changes the design (not just the code) even before that code lands. Treat a PR that changes architecture without a corresponding docs update as incomplete, the same way you'd treat it as incomplete without tests.
