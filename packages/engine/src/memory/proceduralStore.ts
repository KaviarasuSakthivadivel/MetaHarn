/**
 * Procedural memory — durable "how this user/workspace actually operates," formalizing what
 * PermissionEngine (permissions/engine.ts) already tracked but only ever kept in-memory:
 * `sessionAllowTools`/`sessionAllowCommands`/`sessionAllowDomains`/`sessionReadonly` are real
 * standing-rule state, they just evaporate the moment a session ends. This store is that same
 * shape of grant, made durable and cross-session.
 *
 * Write policy: deliberately NOT "the first time someone clicks Always Allow, remember it
 * forever." A single click is still just a session grant — this store only OBSERVES it
 * (`observe()`, called from the same `allow*ForSession` methods a click already triggers).
 * A rule only becomes something `PermissionEngine.evaluate()` will actually honor
 * (`listPromoted()`) once it's been observed across `PROMOTION_THRESHOLD` DISTINCT sessions —
 * a real "the user keeps doing this," not a single in-the-moment click, which is what makes
 * promoting it to a durable, silently-honored grant defensible rather than a silent
 * escalation-through-repetition risk. This mirrors the security posture already established
 * elsewhere in this package (the self-protection floor, persistent-authority tools needing a
 * human) — nothing here bypasses the reviewer in auto-approve mode either; see engine.ts's
 * `honorSessionGrants` gate, which a promoted rule is subject to exactly like a session grant.
 *
 * Retrieval: `listPromoted()`, consulted by PermissionEngine at the same point session grants
 * are — additive, never replacing the mode/allowlist checks ahead of it.
 *
 * Decay: `pruneStale()` — a promoted rule that hasn't actually fired in `staleDays` is
 * retired. Conflict resolution for this tier is naturally simpler than prose facts: rules are
 * an additive allow-list over a small discrete (kind, value) space, so there's no contradiction
 * to resolve, only staleness (a rule that made sense once but nobody's used since) and explicit
 * revocation (`revoke()`), which the Settings UI exposes directly.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type ProceduralScope = "global" | "workspace";
export type ProceduralKind = "tool" | "command" | "domain" | "readonly";

/** Distinct sessions a grant must be observed in before it's honored without a human present
 * for that session. Three, not one: a single session's "always allow" is still just that
 * session's own grant (PermissionEngine's existing sessionAllow* Sets already cover it) —
 * this store's whole point is only promoting a genuinely repeated pattern. */
const PROMOTION_THRESHOLD = 3;

export interface ProceduralRule {
  id: number;
  scope: ProceduralScope;
  workspace?: string;
  kind: ProceduralKind;
  value: string;
  observedSessions: number;
  promoted: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ProceduralObserveInput {
  scope: ProceduralScope;
  workspace?: string;
  kind: ProceduralKind;
  /** The tool name / exact command text / domain host; empty string for "readonly" (a
   * session-wide grant with no single value of its own). */
  value: string;
  sessionId: string;
}

interface RuleRow {
  id: number;
  scope: string;
  workspace: string | null;
  kind: string;
  value: string;
  promoted: number;
  created_at: string;
  last_used_at: string | null;
}

function rowToRule(row: RuleRow, observedSessions: number): ProceduralRule {
  return {
    id: row.id,
    scope: row.scope as ProceduralScope,
    workspace: row.workspace ?? undefined,
    kind: row.kind as ProceduralKind,
    value: row.value,
    observedSessions,
    promoted: row.promoted === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export class SqliteProceduralStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS procedural_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        workspace TEXT,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        promoted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_used_at TEXT,
        UNIQUE(scope, workspace, kind, value)
      );
      CREATE TABLE IF NOT EXISTS procedural_observations (
        rule_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        PRIMARY KEY (rule_id, session_id)
      );
    `);
  }

  private observedCount(ruleId: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM procedural_observations WHERE rule_id = ?").get(ruleId) as { n: number };
    return row.n;
  }

  private findRuleId(scope: ProceduralScope, workspace: string | undefined, kind: ProceduralKind, value: string): number | undefined {
    const row = this.db
      .prepare("SELECT id FROM procedural_rules WHERE scope = ? AND workspace IS ? AND kind = ? AND value = ?")
      .get(scope, workspace ?? null, kind, value) as { id: number } | undefined;
    return row?.id;
  }

  /** Record one session's exercise of a grant. Find-or-create the rule row, record this
   * session against it (idempotent — the same session observing twice doesn't inflate the
   * count), then promote it once the distinct-session count crosses the threshold. */
  observe(input: ProceduralObserveInput): void {
    let ruleId = this.findRuleId(input.scope, input.workspace, input.kind, input.value);
    if (ruleId === undefined) {
      const result = this.db
        .prepare("INSERT INTO procedural_rules (scope, workspace, kind, value) VALUES (?, ?, ?, ?)")
        .run(input.scope, input.workspace ?? null, input.kind, input.value);
      ruleId = Number(result.lastInsertRowid);
    }
    this.db.prepare("INSERT OR IGNORE INTO procedural_observations (rule_id, session_id) VALUES (?, ?)").run(ruleId, input.sessionId);
    const count = this.observedCount(ruleId);
    if (count >= PROMOTION_THRESHOLD) {
      this.db.prepare("UPDATE procedural_rules SET promoted = 1 WHERE id = ? AND promoted = 0").run(ruleId);
    }
  }

  /** What PermissionEngine actually consults — promoted rules only, for one scope. */
  listPromoted(scope: ProceduralScope, workspace?: string): ProceduralRule[] {
    const rows = (
      scope === "global"
        ? this.db.prepare("SELECT * FROM procedural_rules WHERE scope = 'global' AND promoted = 1").all()
        : this.db.prepare("SELECT * FROM procedural_rules WHERE scope = 'workspace' AND workspace = ? AND promoted = 1").all(workspace ?? null)
    ) as RuleRow[];
    return rows.map((row) => rowToRule(row, this.observedCount(row.id)));
  }

  /** Every rule for a scope, promoted or not — for the Settings UI, so a not-yet-promoted
   * grant (e.g. "observed in 2/3 sessions") is visible rather than silently invisible until
   * it crosses the threshold. */
  listAll(scope: ProceduralScope, workspace?: string): ProceduralRule[] {
    const rows = (
      scope === "global"
        ? this.db.prepare("SELECT * FROM procedural_rules WHERE scope = 'global' ORDER BY id DESC").all()
        : this.db.prepare("SELECT * FROM procedural_rules WHERE scope = 'workspace' AND workspace = ? ORDER BY id DESC").all(workspace ?? null)
    ) as RuleRow[];
    return rows.map((row) => rowToRule(row, this.observedCount(row.id)));
  }

  /** Bump lastUsedAt when a promoted rule actually fires — the timestamp `pruneStale()` decays
   * against. */
  touch(id: number): void {
    this.db.prepare("UPDATE procedural_rules SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  revoke(id: number): boolean {
    this.db.prepare("DELETE FROM procedural_observations WHERE rule_id = ?").run(id);
    const result = this.db.prepare("DELETE FROM procedural_rules WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** A promoted rule not used in `staleDays` is retired — see module doc for why this,
   * not contradiction detection, is this tier's decay policy. Never touches an unpromoted
   * (still-observing) rule. Returns the number of rules removed. */
  pruneStale(staleDays: number): number {
    const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();
    const stale = this.db
      .prepare("SELECT id FROM procedural_rules WHERE promoted = 1 AND (last_used_at IS NULL OR last_used_at < ?) AND created_at < ?")
      .all(cutoff, cutoff) as { id: number }[];
    for (const row of stale) this.revoke(row.id);
    return stale.length;
  }

  close(): void {
    this.db.close();
  }
}
