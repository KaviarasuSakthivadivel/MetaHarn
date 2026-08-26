# @metaharn/engine

A MetaHarn-owned agent loop — provider routing, tool execution, permissions, MCP, automation,
and memory, built in the open instead of hidden inside `@earendil-works/pi-coding-agent`.
Design rationale: `docs/research/openworker-integration.md` ("Owning the Loop") and
`docs/research/openworker-feature-catalog.md` ("The Parts Bin").

This package is standalone by design for this pass — no Electron/IPC wiring yet. Wiring it
into `apps/desktop` as a chat-session backend is deliberate later work.

## Module map

| File | Owns |
|---|---|
| `src/types.ts` | Every shared contract: canonical `ChatMessage`, provider types (`AssistantTurn`, `StreamChunk`, `TokenUsage`, `ModelCapabilities`), tool types (`ToolDefinition`, `ToolMetadata`, `RiskClass`), permission types (`PermissionEvaluator`, `PermissionDecision`, `Approver`), the reviewer contract (`Reviewer`, `ReviewInput`, `ReviewResult`), and `EngineEvent`. |
| `src/engine.ts` | `Engine` — the turn loop. Consumes `ProviderClient`, `ToolRegistry`, `PermissionEvaluator`, and optionally a `Reviewer`, a `CompactionHook`, and a `ContextProvider`. |
| `src/providers/base.ts` | The `ProviderClient` interface every vendor client implements. |
| `src/providers/router.ts` | `ProviderRouter` — `provider:model` string dispatch to a lazily-built, cached client per vendor. |
| `src/tools/registry.ts` | `ToolRegistry` — name → callable + schema + metadata. |

Nothing outside those five files should need to change for a new tool, permission rule, or
provider to land — every workstream below only ever *adds* files.

## Integration seams (built as standalone modules, not deeply wired into `engine.ts` in this pass)

- **Permissions** (`PermissionEvaluator`): any class with an `evaluate()` method matching the
  interface in `types.ts` plugs straight into `Engine`'s constructor.
- **Reviewer** (`Reviewer`): any class with a `review()` method matching `types.ts` plugs
  into `Engine`'s constructor; `Engine.handleToolCalls` already consults it at the right
  point (see the `§8.4 retry guard` comment in `engine.ts`).
- **Compaction** (`CompactionHook`): a plain function `(messages) => messages`, called once
  per loop iteration before the next model call. The compaction module itself decides
  whether/how to compact; `Engine` just calls whatever it returns.
- **Context provider** (`ContextProvider`): a zero-arg function returning a string appended
  to the latest user message at send time only (mirrors OpenWorker's ephemeral
  `<system-context>` block — the live directory list, a plan-mode reminder, etc.).
- **MCP / automation / memory / self-wake**: each is tools registered via `ToolRegistry`
  plus its own standalone store — no engine-level seam needed beyond the registry itself.

## Provider strings

`provider:model`, e.g. `anthropic:claude-opus-4-5`, `openai:gpt-5.6`, `ollama:llama3.3`. A
bare model string (no colon, or a colon that isn't a known provider prefix — e.g. a version
tag like `qwen2.5-coder:32b`) resolves to `ProviderRouterOptions.defaultProvider`.
