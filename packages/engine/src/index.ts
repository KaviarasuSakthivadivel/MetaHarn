// -- Tier 0: foundation -----------------------------------------------------------------
export * from "./types.js";
export { Engine } from "./engine.js";
export type { EngineOptions } from "./engine.js";
export { ProviderRouter } from "./providers/router.js";
export type { ProviderFactory, ProviderRouterOptions } from "./providers/router.js";
export { defaultStream } from "./providers/base.js";
export type { ProviderClient } from "./providers/base.js";
export { ToolRegistry } from "./tools/registry.js";

// -- Tier 1: built-in tools ---------------------------------------------------------------
export * from "./tools/search.js";
export * from "./tools/git.js";
export * from "./tools/todo.js";
export * from "./tools/ask.js";
export * from "./tools/directories.js";
export * from "./tools/toolreq.js";
export * from "./tools/plan.js";
export * from "./tools/subagent.js";
export * from "./tools/websearch.js";
export * from "./web/fetch.js";
export * from "./web/guard.js";
export * from "./web/providers.js";
export * from "./attachments.js";
export * from "./pdfSupport.js";

// -- Tier 2: permissions & scoping --------------------------------------------------------
export * from "./permissions/roots.js";
export * from "./permissions/risk.js";
export * from "./permissions/engine.js";
export * from "./permissions/shellAllowlist.js";
export * from "./permissions/readonlyClassifier.js";

// -- Tier 3: trust & observability ---------------------------------------------------------
export * from "./trust/sessionFacts.js";
export * from "./trust/provenance.js";
export * from "./trust/workspaceTrust.js";
export * from "./trust/auditStore.js";
export * from "./trust/secretStore.js";

// -- Tier 4: the Auto-Approve reviewer ------------------------------------------------------
// `Reviewer` (the contract) already came from types.js above; reviewer.js's own `Reviewer`
// is the concrete implementation of it, re-exported under a distinct name to avoid ambiguity.
export { INSTRUCTIONS, parseVerdict, Reviewer as ReviewerEngine } from "./reviewer.js";
export type { ReviewerStats, ReviewerOptions } from "./reviewer.js";

// -- Tier 5: context management -------------------------------------------------------------
export * from "./compaction.js";

// -- Tier 6: human-in-the-loop infrastructure ------------------------------------------------
export * from "./hitl/inbox.js";
export * from "./hitl/unattended.js";
export * from "./hitl/buttons.js";

// -- Tier 7: MCP, automation, memory ---------------------------------------------------------
export * from "./mcp/config.js";
export * from "./mcp/client.js";
export * from "./mcp/tools.js";
export * from "./automation/models.js";
export * from "./automation/store.js";
export * from "./automation/scheduler.js";
export * from "./automation/tools.js";
export * from "./automation/selfwake.js";
export * from "./memory/types.js";
export * from "./memory/sqliteStore.js";
export * from "./memory/tools.js";
export * from "./memory/settings.js";

// -- Concrete provider implementations --------------------------------------------------------
export { AnthropicProvider } from "./providers/anthropic.js";
export { OpenAIProvider } from "./providers/openai.js";
