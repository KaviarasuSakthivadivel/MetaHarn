/**
 * Durable local audit log for tool-call actions, backed by `better-sqlite3`.
 *
 * Ported from OpenWorker's `coworker/audit.py`, trimmed to what this package's foundation
 * actually has a shape for. The Python schema carries connector/session-owner/reviewer-
 * metering columns this package has no `connectors.ts` or reviewer-token-metering module to
 * populate yet (see README's module map) — rather than pre-guess that shape, this keeps the
 * columns grounded in `types.ts`'s actual contracts:
 *   - `stage`/`status`/`reason`/`rule` mirror exactly what `Engine.audit()` in `engine.ts`
 *     passes (`{stage, tool, status, reason?, rule?}` — see its `handleToolCalls`).
 *   - `tokensIn`/`tokensOut`/`cacheRead`/`cacheWrite` mirror `TokenUsage` from `types.ts`, for
 *     whoever wires a `Reviewer`'s `ReviewResult.usage` into an audit event later.
 * `append()` accepts the same loose `Record<string, unknown>` shape as `EngineOptions.auditSink`
 * so `new AuditStore(path).append.bind(store)` can be passed there directly.
 */
import Database from "better-sqlite3";

// Substring match against the lowercased key, same as OpenWorker's `_SECRET_KEYS` — deliberately
// loose (a key containing, not equal to, one of these) so `x_api_key`, `refreshToken`, etc. all
// redact.
const SECRET_KEY_SUBSTRINGS = ["token", "secret", "password", "api_key", "access_token"];

const STRING_LIMIT = 500;

function truncate(text: string, limit = STRING_LIMIT): string {
  const flat = text.replace(/\n/g, "\\n");
  return flat.length <= limit ? flat : flat.slice(0, limit - 3) + "...";
}

function isSecretKey(key: string): boolean {
  const lk = key.toLowerCase();
  return SECRET_KEY_SUBSTRINGS.some((s) => lk.includes(s));
}

/**
 * Bound the size of a stored value the way OpenWorker's `_summarize` does (strings
 * truncated, lists/objects capped in breadth, everything else stringified-and-truncated) —
 * PLUS check every nested object key for a secret-shaped name, not just the top level.
 *
 * Deliberate strengthening over the Python original, whose `_summarize` recurses without
 * re-checking `_SECRET_KEYS` at nested levels, so `{"auth": {"password": "..."}}` would keep
 * the password in OpenWorker's log. An audit log is exactly the place partial coverage
 * should err toward more redaction, not less.
 */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value ?? null;
  }
  if (Array.isArray(value)) return value.slice(0, 10).map(sanitizeValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
      out[k] = isSecretKey(k) ? "[redacted]" : sanitizeValue(v);
    }
    return out;
  }
  return truncate(String(value));
}

/** Redact any argument key containing token/secret/password/api_key/access_token
 * (case-insensitively), at every nesting level, then bound the size of everything else. */
export function redactArguments(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? "[redacted]" : sanitizeValue(value);
  }
  return out;
}

function firstString(event: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = event[key];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return "";
}

function firstNumber(event: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const v = event[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

export interface AuditListOptions {
  limit?: number;
  sessionId?: string;
  tool?: string;
}

export interface AuditEventRow {
  id: number;
  ts: string;
  sessionId: string;
  tool: string;
  stage: string;
  status: string;
  rule: string;
  reason: string;
  arguments: Record<string, unknown>;
  resultPreview: string;
  callId: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

interface AuditEventDbRow {
  id: number;
  ts: string;
  session_id: string;
  tool: string;
  stage: string;
  status: string;
  rule: string;
  reason: string;
  arguments: string;
  result_preview: string;
  call_id: string;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
}

function fromDbRow(row: AuditEventDbRow): AuditEventRow {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.arguments || "{}");
    if (parsed !== null && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    // malformed JSON in an old row: surface as empty rather than throw on read
  }
  return {
    id: row.id,
    ts: row.ts,
    sessionId: row.session_id,
    tool: row.tool,
    stage: row.stage,
    status: row.status,
    rule: row.rule,
    reason: row.reason,
    arguments: args,
    resultPreview: row.result_preview,
    callId: row.call_id,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
  };
}

export class AuditStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // A durable audit log outlives the process that wrote it; WAL keeps concurrent readers
    // (a UI tailing the log) from blocking the writer mid-turn.
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        tool TEXT NOT NULL DEFAULT '',
        stage TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        rule TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        arguments TEXT NOT NULL DEFAULT '{}',
        result_preview TEXT NOT NULL DEFAULT '',
        call_id TEXT NOT NULL DEFAULT '',
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS audit_events_session_idx ON audit_events(session_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS audit_events_tool_idx ON audit_events(tool)");
  }

  /** Append one event. Accepts the same loose shape `EngineOptions.auditSink` receives —
   * `event.arguments` (if present) is redacted before it ever touches disk. */
  append(event: Record<string, unknown>): void {
    const tool = firstString(event, ["tool", "toolName", "name"]);
    const args = redactArguments(event["arguments"] ?? event["args"]);
    const resultPreview = truncate(
      firstString(event, ["resultPreview", "result_preview"]) || previewOf(event["result"]),
    );
    this.db
      .prepare(
        `INSERT INTO audit_events
           (ts, session_id, tool, stage, status, rule, reason, arguments, result_preview, call_id, tokens_in, tokens_out, cache_read, cache_write)
         VALUES (@ts, @sessionId, @tool, @stage, @status, @rule, @reason, @arguments, @resultPreview, @callId, @tokensIn, @tokensOut, @cacheRead, @cacheWrite)`,
      )
      .run({
        ts: new Date().toISOString(),
        sessionId: firstString(event, ["sessionId", "session_id"]),
        tool,
        stage: firstString(event, ["stage"]),
        status: firstString(event, ["status"]),
        rule: firstString(event, ["rule"]),
        reason: truncate(firstString(event, ["reason"])),
        arguments: JSON.stringify(args),
        resultPreview,
        callId: firstString(event, ["callId", "call_id", "toolCallId"]),
        tokensIn: firstNumber(event, ["tokensIn", "tokens_in"]),
        tokensOut: firstNumber(event, ["tokensOut", "tokens_out"]),
        cacheRead: firstNumber(event, ["cacheRead", "cache_read"]),
        cacheWrite: firstNumber(event, ["cacheWrite", "cache_write"]),
      });
  }

  list(opts: AuditListOptions = {}): AuditEventRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.sessionId) {
      where.push("session_id = @sessionId");
      params.sessionId = opts.sessionId;
    }
    if (opts.tool) {
      where.push("tool = @tool");
      params.tool = opts.tool;
    }
    params.limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    const sql = `SELECT * FROM audit_events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT @limit`;
    const rows = this.db.prepare(sql).all(params) as AuditEventDbRow[];
    return rows.map(fromDbRow);
  }

  close(): void {
    this.db.close();
  }
}

function previewOf(result: unknown): string {
  if (result === undefined) return "";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
