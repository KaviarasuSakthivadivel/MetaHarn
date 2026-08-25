# MetaHarn

A meta-harness for an agentic dev platform: institutional-memory context grounding (ownership, architecture, docs) layered on top of an embedded agent harness ([Pi](https://pi.dev)), rather than reimplementing tool-calling/provider-routing/sandboxing from scratch.

See [docs/PLAN.md](docs/PLAN.md) for the full roadmap and design rationale, and [docs/architecture](docs/architecture/README.md) for the technical map of how the system is actually built — process model, agent runtime, context engine, data model, IPC contract, frontend, and known limitations.

MetaHarn ships as a native desktop app (Electron — macOS first, Windows/Linux to follow), not a web app. The agent runtime (Pi SDK, context engine, catalog DB writes) runs directly in the Electron main process; the renderer talks to it over IPC instead of a WebSocket.

## Quickstart

```bash
docker compose up -d
npm install
npm run db:migrate
npm run dev:desktop   # opens the native MetaHarn window
```

In the window, point it at a local git repo path (ideally one with a `CODEOWNERS` file and a `README.md`), and chat with the agent about that repo.
