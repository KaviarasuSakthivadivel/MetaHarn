/**
 * PermissionEngine — decides allow / deny / ask-user for each proposed tool call.
 *
 * Modes: discuss/plan (read-only) · interactive (auto reads, ask on writes/commands) ·
 * bypass-approvals (full access minus the hard floors) · auto-approve (interactive, but a
 * Reviewer judges each would-be approval first — see `engine.ts`'s `handleToolCalls`) ·
 * custom (interactive + auto-allow a configured tool set). Refined by argument patterns
 * (path-under-root, command prefixes) and session/config allowlists. This class only
 * *decides* — `Engine` (engine.ts) routes `needsUser` decisions to an `Approver` and records
 * the outcome; it never calls back into this class to persist an "always allow" itself, so a
 * caller wiring a real UI approver is expected to call this class's `allow*ForSession`
 * methods when the user clicks "always allow" before resolving that approval.
 *
 * Ported from OpenWorker's coworker/permissions.py `PermissionEngine`.
 */
import path from "node:path";
import type { PermissionDecision, PermissionEvaluator, ToolMetadata } from "../types.js";
import { classify, isConsequential, type RiskOverrides } from "./risk.js";
import { normalizeRoots, resolveRealPath, type RootDir, type RootDirInput } from "./roots.js";
import { isCommandAllowed } from "./shellAllowlist.js";
import { isReadonlyCommand, readTargets } from "./readonlyClassifier.js";

export type Mode = "discuss" | "plan" | "interactive" | "bypass-approvals" | "auto-approve" | "custom";

/** Modes whose enforcement is read-only. `discuss` and `plan` share the same gate; they
 * differ only in intent (plan additionally drives the agent toward a propose-plan flow,
 * which is a tool-level concern, not this engine's). */
const READ_ONLY_MODES = new Set<Mode>(["discuss", "plan"]);

/** Tools granting authority that OUTLIVES this session: instructions the agent will follow
 * in later conversations, or a task that runs on its own afterwards. The reviewer never
 * clears these — same floor as deferred-execution files, for the same reason: the effect
 * lands after the conversation that authorized it has ended, so the person who bears it is
 * not in the room. Overridable via `PermissionEngineOptions.persistentAuthorityTools` since
 * this package's automation workstream may not reuse OpenWorker's exact tool names. */
const DEFAULT_PERSISTENT_AUTHORITY_TOOLS = [
  "save_skill",
  "create_scheduled_task",
  "update_scheduled_task",
  "delete_scheduled_task",
];

// Files INSIDE a workspace that execute on a later, innocuous-looking action. An edit here
// is a deferred command: writing `.git/hooks/pre-commit` and then running `git commit` runs
// it. They stay writable, but never WITHOUT a human — no auto-approve path (bypass mode,
// session grants, allowlists, the reviewer) may clear them. This is the DEFERRED-EXECUTION
// FLOOR and is intentionally NOT configurable — unlike the self-protection floor below, it
// doesn't depend on where any particular app keeps its settings.
const PROTECTED_IN_PROJECT = [
  ".git/hooks/",
  ".github/workflows/",
  ".gitlab-ci.yml",
  ".vscode/tasks.json",
  // Workspace-level policy/skills the agent would otherwise be able to self-grant, mirroring
  // OpenWorker's `.coworker/` entry for the same reason. No workstream owns this concept in
  // this package yet; kept as a forward-looking placeholder under this package's own name.
  ".metaharn/",
];

function isProtectedInProject(candidatePath: string): boolean {
  const posix = candidatePath.split(path.sep).join("/");
  return PROTECTED_IN_PROJECT.some((marker) =>
    marker.endsWith("/") ? posix.includes(`/${marker}`) || posix.startsWith(marker) : posix.endsWith(`/${marker}`),
  );
}

// The argument that names a write tool's target path, when it's a single top-level field.
// Patch/diff tools carry their paths inside the blob instead (handled separately below).
// ASSUMPTION: these are OpenWorker's tool names; this package's write-tool workstream may
// land under different names, in which case pass `writePathArgs` to extend this table (a
// name absent from either fails closed — see `writePaths`'s `located: false` branch).
const DEFAULT_WRITE_PATH_ARGS: Record<string, string> = {
  write_file: "path",
  replace_in_file: "path",
};

// apply_patch (Codex format) file headers, and unified-diff `+++ b/<path>` headers.
const APPLY_PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const APPLY_PATCH_MOVE = /^\*\*\* Move to: (.+)$/gm;
const UNIFIED_DIFF_FILE = /^\+\+\+ (?:b\/)?(.+?)\s*$/gm;

function matchAllGroups(text: string, re: RegExp): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]);
    if (m.index === re.lastIndex) re.lastIndex++; // guard against a zero-length match looping forever
  }
  return out;
}

interface WritePathsResult {
  paths: string[];
  /** False when the path can't be determined (unknown write tool, or a patch/diff blob with
   * no parseable file header) — the caller must fail closed rather than skip scoping. */
  located: boolean;
}

function hostOf(urlOrDomain: string): string {
  const s = (urlOrDomain ?? "").trim().toLowerCase();
  if (!s) return "";
  try {
    if (s.includes("://")) return new URL(s).hostname;
    return new URL("//" + s, "http://placeholder").hostname || s;
  } catch {
    return "";
  }
}

function isUnder(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(withSep);
}

function allow(reason: string, rule?: string): PermissionDecision {
  return { allowed: true, reason, needsUser: false, humanOnly: false, ...(rule ? { rule } : {}) };
}

function deny(reason: string): PermissionDecision {
  return { allowed: false, reason, needsUser: false, humanOnly: false };
}

function ask(reason: string, humanOnly = false): PermissionDecision {
  return { allowed: false, reason, needsUser: true, humanOnly };
}

export interface PermissionEngineOptions {
  workspaceRoot: string;
  /** @default "interactive" */
  mode?: Mode;
  /** Command prefixes that auto-run without asking (matched via `shellAllowlist.ts`). */
  allowedCommands?: string[];
  /** Tool names auto-allowed in `"custom"` mode. */
  autoAllowTools?: string[];
  /** Egress hosts that auto-run without asking (exact match or subdomain). */
  allowedDomains?: string[];
  /** Shared, mutable list of accessible directories. Kept BY REFERENCE and re-normalized on
   * every `evaluate()` call, so pushing/splicing this array at runtime (e.g. after a granted
   * `request_directory` call) takes effect immediately — no need to rebuild the engine.
   * Defaults to a single writable root at `workspaceRoot` when omitted. */
  roots?: RootDirInput[];
  /**
   * SELF-PROTECTION FLOOR. Absolute paths this app's OWN settings/config live at — writes and
   * shell commands touching any of them are refused in EVERY mode, including
   * `"bypass-approvals"`, before mode/allowlists are even consulted. This package doesn't
   * know MetaHarn's real config paths, so this defaults to `[]` (the floor is a no-op until
   * the caller supplies them). THE CALLER MUST PASS THE REAL PATHS (permission config, saved
   * "always allow" grants, secrets, session records, …) for this floor to do anything — see
   * OpenWorker's `protected_paths()` (coworker/permissions.py) for the shape of list to port.
   */
  protectedPaths?: string[];
  /** User-local risk-override resolver (relax a tool's own declared risk; may only tighten a
   * by-name-floored built-in — see `risk.ts`). */
  riskOverrides?: RiskOverrides;
  /** Task-scoped standing rules (`tool -> {allowed targets}`), external-risk tools only. Kept
   * BY REFERENCE and re-read on every check, mirroring `roots`. */
  taskRules?: Map<string, Set<string>>;
  /** Given an external-risk tool name, the argument that names its "target" (for standing
   * rules). No connector/MCP catalog exists in this package yet, so this is inert (no task
   * rule ever fires) unless the caller supplies it. */
  targetArgFor?: (toolName: string) => string | undefined;
  /** Extra `{toolName: argName}` entries for write tools whose target path is a single
   * top-level string argument, merged on top of `DEFAULT_WRITE_PATH_ARGS`. */
  writePathArgs?: Record<string, string>;
  /** Overrides `DEFAULT_PERSISTENT_AUTHORITY_TOOLS`. */
  persistentAuthorityTools?: string[];
}

export class PermissionEngine implements PermissionEvaluator {
  readonly workspaceRoot: string;
  mode: Mode;
  allowedCommands: string[];
  readonly autoAllowTools: Set<string>;
  allowedDomains: string[];
  /** Public and mutable by design — see `PermissionEngineOptions.roots`. */
  roots: RootDirInput[];
  /** Public and mutable by design — see `PermissionEngineOptions.taskRules`. */
  taskRules: Map<string, Set<string>>;

  private readonly protectedPaths: readonly string[];
  private readonly riskOverrides?: RiskOverrides;
  private readonly targetArgFor?: (toolName: string) => string | undefined;
  private readonly writePathArgs: Record<string, string>;
  private readonly persistentAuthorityTools: Set<string>;

  private readonly sessionAllowTools = new Set<string>();
  private readonly sessionAllowCommands = new Set<string>();
  private readonly sessionAllowDomains = new Set<string>();
  private sessionReadonly = false;

  constructor(opts: PermissionEngineOptions) {
    this.workspaceRoot = resolveRealPath(opts.workspaceRoot);
    this.mode = opts.mode ?? "interactive";
    this.allowedCommands = opts.allowedCommands ?? [];
    this.autoAllowTools = new Set(opts.autoAllowTools ?? []);
    this.allowedDomains = opts.allowedDomains ?? [];
    this.roots = opts.roots ?? [{ path: this.workspaceRoot, writable: true }];
    this.taskRules = opts.taskRules ?? new Map();
    this.protectedPaths = (opts.protectedPaths ?? []).map((p) => resolveRealPath(p, this.workspaceRoot));
    this.riskOverrides = opts.riskOverrides;
    this.targetArgFor = opts.targetArgFor;
    this.writePathArgs = { ...DEFAULT_WRITE_PATH_ARGS, ...(opts.writePathArgs ?? {}) };
    this.persistentAuthorityTools = new Set(opts.persistentAuthorityTools ?? DEFAULT_PERSISTENT_AUTHORITY_TOOLS);
  }

  // -- PermissionEvaluator -----------------------------------------------------------

  evaluate(toolName: string, args: Record<string, unknown>, metadata: ToolMetadata): PermissionDecision {
    const arguments_ = args ?? {};
    const isConnector = metadata?.category === "connector";
    const risk = classify(toolName, metadata, this.riskOverrides);
    const isWrite = risk === "write_local";
    const isShell = risk === "exec";
    const isEgress = risk === "egress";
    const consequential = isConsequential(risk);

    // SELF-PROTECTION FLOOR — runs before mode, allowlists and every auto-approve path,
    // because the escalation it blocks (approve one ordinary-looking command, it quietly
    // widens the rules, every future session is more permissive) happens in the DEFAULT
    // mode. Nothing below this can reach these paths, and no human click in the flow can
    // grant it either: loosening requires editing the files out-of-band.
    if (isWrite || isShell) {
      const hit = this.touchesProtected(toolName, arguments_, isShell);
      if (hit !== undefined) {
        return deny(`refusing to modify this app's own settings: ${hit}`);
      }
    }

    // Discuss / plan modes: read-only.
    if (READ_ONLY_MODES.has(this.mode) && consequential) {
      return deny(`${this.mode} mode is read-only`);
    }

    // Path scoping for writes (all modes): every path the write touches must land in a
    // writable root. A write whose path can't be located is not scoped-able, so it fails
    // closed to a human-only approval rather than slipping through auto/custom unscoped.
    let needsHumanForProtected = false;
    if (isWrite) {
      const { paths, located } = this.writePaths(toolName, arguments_);
      if (!located) {
        return ask("cannot determine the write path to scope", true);
      }
      for (const p of paths) {
        if (!this.underWritableRoot(p)) {
          return deny(`path is not in a writable directory: ${p}`);
        }
        // In-project files that run on a later action (git hooks, CI configs) may be
        // edited, but never by an auto-approve path — a human must see it.
        if (isProtectedInProject(this.candidate(p))) {
          needsHumanForProtected = true;
        }
      }
    }

    // Authority outliving the session reaches a person, over the reviewer and over every
    // allowlist below. Placed ahead of the non-consequential return on purpose: these tools
    // are consequential today, but a metadata slip must not be able to switch the floor off.
    // Read-only modes already hard-denied above this.
    if (this.persistentAuthorityTools.has(toolName)) {
      return ask("this outlives the session — approval required", true);
    }

    // Non-consequential tools always run.
    if (!consequential) {
      return allow("low risk");
    }

    // A protected in-project target (git hooks, CI config) skips every auto-approve path
    // below — including bypass mode and the session/config allowlists — and asks.
    if (needsHumanForProtected) {
      return ask("this file runs automatically later — approval required", true);
    }

    // Full access.
    if (this.mode === "bypass-approvals") {
      return allow("full access");
    }

    // interactive / custom / auto-approve: allowlists.
    //
    // In auto-approve, session grants ("always allow this …" clicks) deliberately do NOT
    // auto-allow: out-of-band standing policy (the config allowlists checked via
    // `commandAllowed` / `allowedDomains`) may skip the reviewer, but an in-flow click may
    // not. A domain grant matches on host only and is blind to path/query (where
    // exfiltration rides), and command grants replay as exact text; both are precisely what
    // the reviewer should see. The skipped checks fall through to `needsUser`, which routes
    // to the reviewer.
    const honorSessionGrants = this.mode !== "auto-approve";

    if (isShell) {
      const command = String(arguments_.command ?? "");
      if (isCommandAllowed(command, this.allowedCommands)) {
        return allow("command on allowlist");
      }
      if (honorSessionGrants && command && this.sessionAllowCommands.has(command)) {
        return allow("command allowed for session");
      }
      // Also a session grant: in auto-approve the reviewer judges these rather than the
      // classifier waving them through.
      if (honorSessionGrants && this.sessionReadonly && command) {
        // The classifier vets what a command DOES; the roots vet what it READS. Without the
        // second half, a grant the user reads as "stop asking about my project files" would
        // also cover ~/.aws/credentials, another repo's history, and this app's own
        // secrets — none of which the self-protection floor catches, since that guards
        // writes, not reads.
        if (isReadonlyCommand(command) && readTargets(command).every((t) => this.underRoot(t))) {
          return allow("read-only command (session grant)");
        }
      }
    }
    if (isEgress) {
      const hasUrl = typeof arguments_.url === "string" && arguments_.url.length > 0;
      if (hasUrl) {
        if (this.domainAllowed(String(arguments_.url), honorSessionGrants)) {
          return allow("domain on allowlist");
        }
        // Falls through to `ask` below when the url isn't on the allowlist — a model-chosen
        // destination (web_fetch, browser_open_url) is exactly the SSRF-shaped case domain
        // scoping exists for.
      } else if (metadata?.requiresApproval === false) {
        // No model-chosen destination to scope in the first place (e.g. web_search's `query`
        // isn't a url) — the domain-allowlist check above doesn't apply to it at all, so
        // honor the tool's own declaration instead of silently falling through to `ask`
        // regardless of what it says. Found live: web_search (risk floored to "egress" by
        // name, requiresApproval: false in its own metadata) sat in the Inbox forever on
        // every call — its own author's "no SSRF surface here" reasoning (see
        // tools/websearch.ts's doc comment) was correct, evaluate() just never consulted it.
        return allow("no destination to scope; tool declares no approval needed");
      }
    }
    if (honorSessionGrants && this.sessionAllowTools.has(toolName) && !isConnector) {
      return allow("tool allowed for session");
    }

    // Task-scoped standing rules: tool + exact target, owned by the automation. Deliberately
    // NOT subject to the connector exclusion above — the exact-target binding is what makes
    // auto-allowing a connector tool safe. Never for exec risk (candidate extraction below is
    // external-risk-only), and additive on top of the mode: read-only modes already returned
    // before this point.
    const ruleTargets = this.taskRules.get(toolName);
    if (ruleTargets) {
      const target = this.standingRuleCandidate(toolName, arguments_, metadata);
      if (target && ruleTargets.has(target)) {
        const rule = `${toolName} → ${target}`;
        return allow(`allowed by standing rule: ${rule}`, rule);
      }
    }

    // Custom mode auto-approves the configured tools.
    if (this.mode === "custom" && this.autoAllowTools.has(toolName)) {
      return allow("auto-allowed by config");
    }

    // Otherwise: ask the user.
    return ask("requires approval");
  }

  // -- session memory -----------------------------------------------------------------

  allowToolForSession(toolName: string): void {
    this.sessionAllowTools.add(toolName);
  }

  allowCommandForSession(command: string): void {
    if (command) this.sessionAllowCommands.add(command);
  }

  allowReadonlyForSession(): void {
    this.sessionReadonly = true;
  }

  /** Remember an egress destination for this session ("Always allow this domain"). A leading
   * `www.` is stripped at minting: `bbc.com` and `www.bbc.com` are one site in every user's
   * mental model, and the suffix match in `domainAllowed` already treats `www.bbc.com` as a
   * subdomain of `bbc.com`. Pure spelling only — never eTLD+1 or any broader normalization,
   * which would silently widen the grant. */
  allowDomainForSession(urlOrDomain: string): void {
    let host = hostOf(urlOrDomain);
    if (host.startsWith("www.")) host = host.slice(4);
    if (host) this.sessionAllowDomains.add(host);
  }

  // -- helpers --------------------------------------------------------------------------

  private resolvedRoots(): RootDir[] {
    return normalizeRoots(this.roots);
  }

  /** Relative paths resolve against `workspaceRoot`; absolute/`~` paths are taken as-is. */
  private candidate(p: string): string {
    return resolveRealPath(p, this.workspaceRoot);
  }

  private underRoot(p: string): boolean {
    const candidate = this.candidate(p);
    return this.resolvedRoots().some((r) => isUnder(candidate, r.path));
  }

  private underWritableRoot(p: string): boolean {
    const candidate = this.candidate(p);
    return this.resolvedRoots().some((r) => r.writable && isUnder(candidate, r.path));
  }

  private writePaths(toolName: string, args: Record<string, unknown>): WritePathsResult {
    const argName = this.writePathArgs[toolName];
    if (argName !== undefined) {
      const value = args[argName];
      return value ? { paths: [String(value)], located: true } : { paths: [], located: false };
    }
    if (toolName === "apply_patch") {
      const blob = String(args.patch ?? "");
      const paths = [...matchAllGroups(blob, APPLY_PATCH_FILE), ...matchAllGroups(blob, APPLY_PATCH_MOVE)];
      return { paths: paths.map((p) => p.trim()), located: paths.length > 0 };
    }
    if (toolName === "apply_unified_diff") {
      const blob = String(args.diff ?? "");
      const paths = matchAllGroups(blob, UNIFIED_DIFF_FILE).filter((p) => p && p !== "/dev/null");
      return { paths, located: paths.length > 0 };
    }
    // Unknown write tool (e.g. one promoted to write via a risk override): we cannot locate
    // its path, so it cannot be auto-scoped.
    return { paths: [], located: false };
  }

  /**
   * The protected settings path this call would modify, or `undefined`.
   *
   * For writes we resolve the real target. For shell we can only inspect the command text —
   * parser depth, so it stops accidents and casual attempts, not a determined adversary (that
   * needs the OS sandbox). Cheap and worth having regardless.
   *
   * Shell matching is on the FULL path only, never a bare filename: matching a settings
   * filename anywhere in a command would refuse unrelated work that merely mentions the name.
   * A command naming the real settings path is refused whether it reads or writes — we cannot
   * tell which from text, and the conservative direction is the right one for these files.
   */
  private touchesProtected(toolName: string, args: Record<string, unknown>, isShell: boolean): string | undefined {
    if (this.protectedPaths.length === 0) return undefined;
    if (isShell) {
      const command = String(args.command ?? "");
      if (!command) return undefined;
      const lowered = command.replace(/\\/g, "/").toLowerCase();
      for (const target of this.protectedPaths) {
        if (lowered.includes(target.replace(/\\/g, "/").toLowerCase())) return target;
      }
      return undefined;
    }
    const { paths, located } = this.writePaths(toolName, args);
    if (!located) return undefined; // unlocatable writes are already failed closed by the caller
    const resolved = new Set(paths.map((p) => this.candidate(p)));
    for (const target of this.protectedPaths) {
      if (resolved.has(target)) return target;
    }
    return undefined;
  }

  /** True when the URL's host is an allowed egress destination — an exact match or a
   * subdomain of an allowed domain (so `docs.python.org` matches `python.org`, but
   * `evil-python.org` never matches `python.org`). `includeSession=false` (auto-approve mode)
   * checks the config list only: mid-session "always allow this domain" clicks don't bypass
   * the reviewer there. */
  private domainAllowed(url: string, includeSession: boolean): boolean {
    const host = hostOf(url);
    if (!host) return false;
    const allowed = new Set([...this.allowedDomains.map(hostOf).filter(Boolean)]);
    if (includeSession) for (const d of this.sessionAllowDomains) allowed.add(d);
    for (const dom of allowed) {
      if (host === dom || host.endsWith("." + dom)) return true;
    }
    return false;
  }

  /** The target value iff this call is eligible for a task-scoped standing rule:
   * external-risk only (never exec/write-local — shell asks forever), the tool must declare a
   * target argument (via `targetArgFor`), and the call must actually name a target. */
  private standingRuleCandidate(
    toolName: string,
    args: Record<string, unknown>,
    metadata: ToolMetadata,
  ): string | undefined {
    if (classify(toolName, metadata, this.riskOverrides) !== "external") return undefined;
    const argName = this.targetArgFor?.(toolName);
    if (!argName) return undefined;
    const value = String(args[argName] ?? "").trim();
    return value || undefined;
  }
}
