import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { buildContextDoc, whoOwns } from "@metaharn/context-engine";
import { ensureOrgAndRepo } from "./catalog.js";

const MODEL_PROVIDER = process.env.METAHARN_MODEL_PROVIDER ?? "anthropic";
const MODEL_ID = process.env.METAHARN_MODEL_ID ?? "claude-opus-4-5";

/** Read-only, for the Settings page — actually changing this means editing .env for now. */
export function getModelConfig() {
  return { provider: MODEL_PROVIDER, modelId: MODEL_ID };
}

export interface CreateMetaHarnSessionOptions {
  /** Resume a specific past session file instead of starting a fresh one. */
  resumeSessionPath?: string;
}

/**
 * Creates a Pi agent session scoped to `repoPath`, with the context engine's
 * institutional-memory doc injected as a virtual AGENTS.md and a `who_owns`
 * tool backed by the repo's real CODEOWNERS file. This is the whole "meta
 * harness" idea in one function: Pi supplies the agent loop, MetaHarn supplies
 * the grounding.
 */
export async function createMetaHarnSession(repoPath: string, options: CreateMetaHarnSessionOptions = {}) {
  const modelRuntime = await ModelRuntime.create();
  const { org, repo } = await ensureOrgAndRepo(repoPath);

  const whoOwnsTool = defineTool({
    name: "who_owns",
    label: "Who Owns",
    description:
      "Look up the CODEOWNERS entry for a file or directory path in this repository. " +
      "Use this whenever you need to know who owns or is responsible for a piece of code.",
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative path to look up, e.g. 'src/auth/login.ts'" }),
    }),
    execute: async (_toolCallId, params) => {
      const owners = whoOwns(repoPath, params.path);
      return {
        content: [
          {
            type: "text" as const,
            text: owners
              ? `${params.path} is owned by: ${owners.join(", ")}`
              : `No CODEOWNERS entry matches ${params.path}.`,
          },
        ],
        details: { owners },
      };
    },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: repoPath,
    agentDir: getAgentDir(),
    agentsFilesOverride: (current) => ({
      agentsFiles: [
        ...current.agentsFiles,
        { path: "/virtual/AGENTS.md", content: buildContextDoc(repoPath) },
      ],
    }),
  });
  await resourceLoader.reload();

  // Best-effort — falls back to Pi's normal default resolution (restored
  // session model, settings default, or first available) if not found.
  const model = modelRuntime.getModel(MODEL_PROVIDER, MODEL_ID) ?? undefined;

  // Hoisted (rather than inlined into createAgentSession) so ipc.ts can hold
  // onto this instance directly for tree/branch navigation — we own it, no
  // need to go through AgentSession for that.
  const sessionManager = options.resumeSessionPath
    ? SessionManager.open(options.resumeSessionPath)
    : SessionManager.create(repoPath);

  const { session } = await createAgentSession({
    cwd: repoPath,
    model,
    modelRuntime,
    resourceLoader,
    customTools: [whoOwnsTool],
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "who_owns"],
    sessionManager,
  });

  return { session, sessionManager, orgId: org.id, repoId: repo.id };
}

export type MetaHarnSession = Awaited<ReturnType<typeof createMetaHarnSession>>["session"];
