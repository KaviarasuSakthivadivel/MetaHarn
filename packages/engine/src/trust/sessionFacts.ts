/**
 * Session facts — what was already familiar when the session began, and what arrived from
 * outside since.
 *
 * Both are deterministic: no model is involved in producing either. In v1 neither changes a
 * decision. The known world is rendered into the reviewer's prefix as orientation; ingestion
 * goes to the audit log and nothing reads it. That is deliberate — recording it now means a
 * later question ("would this fact have changed a verdict?") is answerable by replaying a
 * shadow run instead of re-arguing it.
 *
 * Ported from OpenWorker's coworker/session_facts.py.
 */
import { execFile } from "node:child_process";
import type { ToolMetadata } from "../types.js";

// Tool categories whose results carry content from outside this machine. Keyed on the
// category rather than a list of tool names so new connectors are covered the day they ship:
//   web        web_fetch, web_search
//   connector  gmail, slack, notion, … — anything reading a third-party service
//   mcp        third-party MCP tools, provenance unknown by construction
// Deliberately absent: "search" (that's local grep), "filesystem", "git", "shell". Local
// reads are excluded on purpose: count them and every turn becomes an ingestion turn, which
// kills the signal. The cost of that exclusion is real — a poisoned README in a cloned repo
// injects with no fact at all — and is accepted rather than papered over.
export const INGESTING_CATEGORIES: ReadonlySet<string> = new Set(["web", "connector", "mcp"]);

/** True when this tool's result can carry content authored outside the machine. */
export function isIngesting(metadata: ToolMetadata | undefined): boolean {
  return metadata !== undefined && INGESTING_CATEGORIES.has(metadata.category);
}

/**
 * A short, non-identifying label for where content came from — a hostname when the call
 * names one, "-" otherwise. Never the content itself, and never a full URL: a query string
 * is exactly the kind of thing that carries a payload.
 */
export function ingestionSource(args: Record<string, unknown> | undefined | null): string {
  const raw = String((args ?? {})["url"] ?? "").trim();
  if (!raw) return "-";
  try {
    const hostname = new URL(raw).hostname;
    return (hostname || "-").toLowerCase();
  } catch {
    return "-";
  }
}

/** Best-effort hostname of a git remote URL — handles both `scheme://host/...` and the SCP
 * short form (`git@host:owner/repo.git`) that `git remote -v` prints for SSH remotes. */
function hostnameOfRemote(rawUrl: string): string | undefined {
  const withScheme = rawUrl.includes("://") ? rawUrl : `http://${rawUrl.replace(":", "/")}`;
  try {
    const hostname = new URL(withScheme).hostname;
    return hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * `(name, url)` per remote, deduplicated (git prints fetch and push separately).
 *
 * Best-effort by design: no git, not a repo, or a hang all yield an empty list. An empty
 * known world is a reviewer with less orientation, never a blocked session. Async rather
 * than the Python original's blocking `subprocess.run` — this engine runs on a shared event
 * loop (see engine.ts's module docstring), so a hung `git` must not stall it.
 */
function gitRemotes(cwd: string): Promise<Array<[string, string]>> {
  return new Promise((resolvePromise) => {
    execFile("git", ["remote", "-v"], { cwd, timeout: 5000 }, (err, stdout) => {
      if (err || typeof stdout !== "string") {
        resolvePromise([]);
        return;
      }
      const seen = new Map<string, string>();
      for (const line of stdout.split("\n")) {
        const parts = line.trim().split(/\s+/).filter(Boolean);
        if (parts.length >= 2 && !seen.has(parts[0])) seen.set(parts[0], parts[1]);
      }
      resolvePromise([...seen.entries()]);
    });
  });
}

export interface RootInfo {
  readonly path: string;
  readonly writable: boolean;
}

export interface RemoteInfo {
  readonly name: string;
  readonly url: string;
}

/**
 * Where the user was already working when the session started. Frozen on purpose.
 *
 * Freezing is what makes it useful: compared against the *live* state, an agent that runs
 * `git remote add backup https://attacker.net/r.git` would make its own destination look
 * familiar. Compared against a snapshot taken before it acted, it cannot.
 *
 * "Known" means *familiar*, never *safe* — nobody decided anything, the user has simply
 * worked here before. The wording matters because the reviewer reads it: told something is
 * "trusted", a model weighs it as reassurance. (`workspaceTrust.ts` keeps the word "trusted"
 * because that one IS a decision.)
 */
export class KnownWorld {
  readonly roots: readonly RootInfo[];
  readonly remotes: readonly RemoteInfo[];
  /** Held for future use, deliberately NOT rendered — see `render()`. */
  readonly hosts: readonly string[];
  readonly capturedAt: number;

  constructor(
    init: {
      roots?: readonly RootInfo[];
      remotes?: readonly RemoteInfo[];
      hosts?: readonly string[];
      capturedAt?: number;
    } = {},
  ) {
    this.roots = Object.freeze([...(init.roots ?? [])]);
    this.remotes = Object.freeze([...(init.remotes ?? [])]);
    this.hosts = Object.freeze([...(init.hosts ?? [])]);
    this.capturedAt = init.capturedAt ?? 0;
    Object.freeze(this);
  }

  /**
   * The block that sits in the reviewer prompt's cached prefix.
   *
   * Folders and remotes only. Hostnames are held in `hosts` but deliberately not shown: a
   * host list is only useful to a reviewer that can answer "is this destination in the
   * list?", and that is a suffix match (`host === dom || host.endsWith("." + dom)`) which
   * models get wrong and code does not. Printing `github.com` beside an action reaching
   * `github.com.evil.site` invites the wrong answer rather than preventing it. Folders and
   * remotes carry no such trap — judging them is "is this the thing I was told about?", not
   * string arithmetic.
   */
  render(): string {
    const lines = ["KNOWN WORLD (frozen when this session started)"];
    for (const { path, writable } of this.roots) {
      lines.push(`  folder   ${path}  [${writable ? "read-write" : "read-only"}]`);
    }
    for (const { name, url } of this.remotes) {
      lines.push(`  remote   ${name} -> ${url}`);
    }
    return lines.length > 1 ? lines.join("\n") : "";
  }
}

export interface CaptureRoot {
  path: string;
  writable?: boolean;
}

export interface CaptureOptions {
  roots?: Iterable<CaptureRoot | string>;
  allowedDomains?: Iterable<string>;
  /** Where to run `git remote -v` from. Defaults to the first root, if any. */
  workspace?: string;
}

/** Take the snapshot. Call once, at session start, before the agent has acted. */
export async function capture(opts: CaptureOptions = {}): Promise<KnownWorld> {
  const rootList = [...(opts.roots ?? [])];
  const roots: RootInfo[] = rootList.map((r) =>
    typeof r === "string" ? { path: r, writable: false } : { path: r.path, writable: Boolean(r.writable) },
  );

  const firstRoot = rootList.length > 0 ? rootList[0] : undefined;
  const cwd = opts.workspace ?? (typeof firstRoot === "string" ? firstRoot : firstRoot?.path);
  const remotePairs = cwd ? await gitRemotes(cwd) : [];
  const remotes: RemoteInfo[] = remotePairs.map(([name, url]) => ({ name, url }));

  const hosts = new Set<string>();
  for (const d of opts.allowedDomains ?? []) {
    const v = d?.trim().toLowerCase();
    if (v) hosts.add(v);
  }
  for (const { url } of remotes) {
    const host = hostnameOfRemote(url);
    if (host) hosts.add(host.toLowerCase());
  }

  return new KnownWorld({
    roots,
    remotes,
    hosts: [...hosts].sort(),
    // Epoch milliseconds (JS convention) — unlike the Python original's `time.time()`
    // seconds. Nothing in v1 reads this field, so the unit is not load-bearing.
    capturedAt: Date.now(),
  });
}

export interface IngestionAudit {
  stage: string;
  status: string;
  reason: string;
}

/**
 * One arrival of outside content. The fact and its source — never the content.
 *
 * Two properties worth keeping in mind before anything consumes this:
 *   - It never accuses. The record is identical for an agent following a documentation link
 *     found in an issue and for one running an injected `curl`, because in both cases the
 *     agent really did read that issue. It raises the burden of proof; judging scope is what
 *     separates the two.
 *   - Its absence is not proof of a clean session. Local reads are excluded, so a poisoned
 *     file already in the workspace produces no record at all.
 */
export class Ingestion {
  constructor(
    readonly turn: number,
    readonly tool: string,
    readonly source: string,
  ) {}

  toAudit(): IngestionAudit {
    return { stage: "ingested", status: "external", reason: `turn ${this.turn} · ${this.source}` };
  }
}

/**
 * The known world plus the per-turn ingestion record.
 *
 * `turn` is bumped at the start of each user turn (call `beginTurn()`) so ingestion can be
 * attributed. Nothing in v1 reads `ingestions` — it exists so the audit log has a baseline.
 */
export class SessionFacts {
  world: KnownWorld;
  turn = 0;
  readonly ingestions: Ingestion[] = [];

  constructor(world: KnownWorld = new KnownWorld()) {
    this.world = world;
  }

  beginTurn(): void {
    this.turn += 1;
  }

  note(tool: string, args: Record<string, unknown> | undefined): Ingestion {
    const record = new Ingestion(this.turn, tool, ingestionSource(args));
    this.ingestions.push(record);
    return record;
  }

  thisTurn(): Ingestion[] {
    return this.ingestions.filter((i) => i.turn === this.turn);
  }
}
