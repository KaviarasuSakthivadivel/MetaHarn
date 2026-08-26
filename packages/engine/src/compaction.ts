/**
 * Auto-compaction of long session histories. TypeScript sibling of OpenWorker's
 * coworker/compaction.py (OPE-27). When the outbound history approaches the model's context
 * limit, the older portion is replaced with (a) an LLM-written structured summary and (b)
 * mechanically extracted state — the recent turns and every user message survive.
 *
 * `createCompactionHook()` returns a `CompactionHook` (types.ts): `(messages) => messages |
 * Promise<messages>`. It never mutates the array it receives — no compaction fires by
 * returning that same reference, and compaction fires by building and returning a brand NEW
 * array, `[instructions?, compactedBlock, ...verbatimTail]`.
 *
 * One load-bearing adaptation from the Python source: engine.ts's loop() does
 *   `const compacted = await this.compaction(this.messages); this.messages.length = 0;
 *   this.messages.push(...compacted);`
 * — i.e. THIS module's return value becomes the new canonical `Engine.messages` from that
 * iteration on (Python keeps canonical history and the compacted outbound view separate;
 * this engine doesn't). Two consequences, both handled here:
 *   1. There is no external place to stash a `CompactionState` between calls (Python's
 *      `build_state(..., prior=...)` is fed by a caller-owned store). Instead, the compacted
 *      leading message carries its own state as sidecars (`summaryText`, `userMessages`,
 *      `userMessagesDropped` — ChatMessage's `[sidecar: string]: unknown` is exactly this
 *      mechanism, already used by engine.ts itself for `notice`/`kind`). A later compaction
 *      pass reads those sidecars back out to fold the prior summary into the next one,
 *      exactly like Python's repeated-compaction path — just state-in-the-array instead of
 *      state-in-a-store. It also means the state survives a session reload for free, same as
 *      Python's persisted `CompactionState`.
 *   2. The compacted block uses role **"system"**, not Python's "user" (`apply_to_outbound`
 *      appends it as `{role: "user", ...}`) and not "notice" either. engine.ts's
 *      `outboundMessages()` strips every `role === "notice"` message before it ever reaches
 *      the provider ("they never leave this process") — a notice-role block would be
 *      silently discarded, making compaction a no-op that still burns a summarizer call
 *      every iteration. "system" is the only role of the two offered that actually reaches
 *      the provider; the placement (right after any real instructions message, ahead of the
 *      verbatim tail) otherwise mirrors Python's `apply_to_outbound` exactly.
 *
 * Also: engine.ts's loop() calls `this.compaction(this.messages)` OUTSIDE its try/catch (only
 * `streamTurn()` is guarded) — a hook that throws would abort the whole turn with no `error`
 * event. So this hook never throws: a failed/empty summarizer call fails open (history
 * returned unchanged; the next real provider round-trip surfaces any genuine overflow itself,
 * same escape hatch Python's `is_context_overflow` exists for downstream).
 */
import type { ChatMessage, CompactionHook, ContentPart } from "./types.js";
import type { ProviderClient } from "./providers/base.js";

// Trigger: min(thresholdPct * contextWindow, capTokens). The cap exists so huge-context
// models still compact early — quality and latency degrade well before the nominal limit.
export const DEFAULT_THRESHOLD_PCT = 0.8;
export const DEFAULT_CAP_TOKENS = 250_000;
// Models the caller doesn't have a verified context-window figure for.
export const DEFAULT_CONTEXT_WINDOW = 128_000;
// The newest slice kept verbatim, as a fraction of the trigger (a token budget, not a turn
// count — one huge tool loop shouldn't starve the working set).
export const KEEP_RECENT_FRACTION = 0.25;
// User messages preserved mechanically in the compacted block, capped to the newest N across
// repeated compactions (otherwise the block appends forever and reclaims the window it
// freed). Dropped ones stay counted — their intent lives in the summary too.
export const USER_MESSAGES_MAX = 40;
export const USER_MESSAGE_CLIP = 600;

// The summarizer call itself: tools off, modest ceiling.
const SUMMARY_MAX_TOKENS = 3_000;
// Per-message clip when rendering the span for the summarizer; tool results are the first
// casualty (huge and mostly stale — a file read 40 turns ago is better re-read than replayed).
const SPAN_TOOL_RESULT_CLIP = 400;
const SPAN_BUDGET_CHARS = 400_000;

/** Sidecar marker on the compacted leading message — `kind` is the same field engine.ts
 * itself already reads off `notice` rows, so this rides the codebase's existing convention. */
const COMPACTION_KIND = "compaction-summary";

export interface CreateCompactionHookOptions {
  provider: ProviderClient;
  model: string;
  /** The target model's context window, in tokens. Falls back to DEFAULT_CONTEXT_WINDOW when
   * omitted/falsy — mirrors Python's `Optional[int]` handling. */
  contextWindow?: number;
  thresholdPct?: number;
  capTokens?: number;
}

// -- token math -----------------------------------------------------------------------------

/** chars/4 over the serialized messages — the documented fallback signal for providers that
 * never report usage. */
export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    try {
      total += JSON.stringify(msg).length;
    } catch {
      total += String(msg).length;
    }
  }
  return Math.floor(total / 4);
}

export function triggerTokens(
  contextWindow: number | undefined,
  opts: { thresholdPct?: number; capTokens?: number } = {},
): number {
  const thresholdPct = opts.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const capTokens = opts.capTokens ?? DEFAULT_CAP_TOKENS;
  const window = contextWindow || DEFAULT_CONTEXT_WINDOW;
  return Math.min(Math.trunc(thresholdPct * window), Math.trunc(capTokens));
}

export function shouldCompact(
  signal: number,
  contextWindow: number | undefined,
  opts: { thresholdPct?: number; capTokens?: number } = {},
): boolean {
  return signal >= triggerTokens(contextWindow, opts);
}

// -- boundary ---------------------------------------------------------------------------------

/** First index that starts a real turn (user or assistant) — skips any leading system
 * instructions message and/or our own compacted-block header, however many there are. Doubles
 * as the span's start index: since the compacted header (if present) always sits before this
 * point, "everything from here to the boundary" is exactly "everything not already folded
 * into a prior summary". */
function firstTurnIndex(messages: ChatMessage[]): number {
  let i = 0;
  while (i < messages.length && messages[i].role !== "user" && messages[i].role !== "assistant") i++;
  return i;
}

/** The outbound index where the verbatim tail begins: the earliest turn start whose suffix
 * fits `keepTokens`. Prefers user-message boundaries (a whole turn); falls back to an
 * iteration (assistant) boundary when the single newest turn alone blows the budget (a giant
 * tool loop). Null when there's nothing meaningful to summarize. */
export function pickBoundary(messages: ChatMessage[], keepTokens: number): number | null {
  const start = firstTurnIndex(messages);
  const users: number[] = [];
  const assistants: number[] = [];
  for (let i = start; i < messages.length; i++) {
    const role = messages[i].role;
    if (role === "user") users.push(i);
    else if (role === "assistant") assistants.push(i);
  }

  const fits = (i: number): boolean => estimateTokens(messages.slice(i)) <= keepTokens;
  const fit = (candidates: number[]): number | null => {
    for (const i of candidates) if (fits(i)) return i; // earliest-first: keep as much as fits
    return null;
  };

  let boundary = fit(users);
  if (boundary === null && users.length > 0) {
    // The newest user turn alone blows the budget — cut inside it at an iteration boundary,
    // keeping at least the most recent assistant step.
    const lastUser = users[users.length - 1];
    const inside = assistants.filter((i) => i > lastUser);
    boundary = fit(inside);
    if (boundary === null) boundary = inside.length ? inside[inside.length - 1] : lastUser;
  }
  if (boundary === null) {
    boundary = fit(assistants) ?? (assistants.length ? assistants[assistants.length - 1] : null);
  }
  // A boundary at (or before) the first real message summarizes nothing — skip.
  if (boundary === null || boundary <= start) return null;
  return boundary;
}

// -- mechanical extraction (no LLM — zero hallucination risk) ---------------------------------

const WRITE_HINTS = ["write", "edit", "append", "save", "create", "patch"];
const ARTIFACT_HINTS = ["artifact", "publish", "deploy"];

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

/** Every tool call in the span, in order, paired with its result (matched by call id). */
function iterToolCalls(span: ChatMessage[]): ToolCallRecord[] {
  const results = new Map<string, unknown>();
  for (const m of span) {
    if (m.role === "tool" && typeof m.toolCallId === "string") results.set(m.toolCallId, m.content);
  }
  const out: ToolCallRecord[] = [];
  for (const msg of span) {
    if (msg.role !== "assistant" || !msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      out.push({ name: tc.function.name || "", args, result: results.get(tc.id) });
    }
  }
  return out;
}

function resultStatus(result: unknown): string {
  if (typeof result !== "string") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return "";
  }
  if (typeof parsed !== "object" || parsed === null) return "";
  const obj = parsed as Record<string, unknown>;
  if (obj.error) return "error";
  if ("exit_code" in obj) {
    const code = obj.exit_code;
    return code === 0 || code === "0" ? "ok" : `exit ${String(code)}`;
  }
  return "";
}

function dedupeRecentFirst(items: string[], limit: number): string[] {
  const seen: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    if (!seen.includes(items[i])) seen.push(items[i]);
    if (seen.length >= limit) break;
  }
  return seen;
}

/** The mechanical block appended to the summary — from the span's tool-call records, not the
 * model: files written, recent commands (+ exit status), artifacts, tools used. Assumption:
 * the shell tool is named exactly "run_shell" (Python's convention) — update if Tier-1's
 * actual tool name differs. */
function extractWorkingState(span: ChatMessage[]): string {
  const files: string[] = [];
  const commands: string[] = [];
  const artifacts: string[] = [];
  const tools: string[] = [];
  for (const { name, args, result } of iterToolCalls(span)) {
    if (name && !tools.includes(name)) tools.push(name);
    const lowered = name.toLowerCase();
    const path = args.path ?? args.file_path;
    if (path && WRITE_HINTS.some((h) => lowered.includes(h))) files.push(String(path));
    if (lowered === "run_shell" && args.command) {
      const status = resultStatus(result);
      const line = String(args.command).split(/\s+/).filter(Boolean).join(" ").slice(0, 160);
      commands.push(status ? `${line}  [${status}]` : line);
    }
    if (ARTIFACT_HINTS.some((h) => lowered.includes(h))) {
      const location = args.url ?? args.path ?? args.title;
      if (location) artifacts.push(String(location));
    }
  }

  const lines = ["## Working state (extracted mechanically from tool records)"];
  const written = dedupeRecentFirst(files, 20);
  if (written.length) {
    lines.push("Files written/edited (most recent first):");
    lines.push(...written.map((p) => `- ${p}`));
  }
  const recentCmds = commands.slice(-10);
  if (recentCmds.length) {
    lines.push("Recent shell commands:");
    lines.push(...recentCmds.map((c) => `- ${c}`));
  }
  const made = dedupeRecentFirst(artifacts, 10);
  if (made.length) {
    lines.push("Artifacts produced:");
    lines.push(...made.map((a) => `- ${a}`));
  }
  if (tools.length) lines.push("Tools used in the summarized span: " + [...tools].sort().join(", "));
  return lines.length > 1 ? lines.join("\n") : "";
}

/** A message's text, whichever content shape it uses (images/files become a placeholder). */
function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content as ContentPart[]) {
      if (p.type === "text") parts.push(p.text);
      else if (p.type === "image_url") parts.push("[image]");
      else if (p.type === "file") parts.push(`[file: ${p.file.filename}]`);
    }
    return parts.join("\n");
  }
  return content == null ? "" : String(content);
}

/** Every user message in the span, chronological, trimmed of pasted bulk. Preserved
 * mechanically — the summarizer is also asked to list them, but user words are the ground
 * truth of intent and must not depend on an LLM remembering to include them. */
function extractUserMessages(span: ChatMessage[], clip: number = USER_MESSAGE_CLIP): string[] {
  const out: string[] = [];
  for (const msg of span) {
    if (msg.role !== "user") continue;
    const text = textOf(msg.content).split(/\s+/).filter(Boolean).join(" ");
    if (!text) continue;
    out.push(text.length > clip ? text.slice(0, clip - 1) + "…" : text);
  }
  return out;
}

/** Newest-`limit` slice plus the running total of everything ever dropped. */
function capUserMessages(
  messages: string[],
  priorDropped: number,
  limit: number = USER_MESSAGES_MAX,
): [string[], number] {
  if (messages.length <= limit) return [messages, priorDropped];
  return [messages.slice(-limit), priorDropped + (messages.length - limit)];
}

// -- summarizer ---------------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT = `You are compacting an AI coworker's session history so the coworker can continue working in a smaller context. Write a structured summary of the conversation below. It is the coworker's ONLY memory of these turns, so preserve everything load-bearing.

Produce ALL of the following sections, in this order, each as a markdown heading:

1. **Primary request and intent** — what the user is trying to get done, in their terms, including standing constraints stated at any point (e.g. "never send without my approval"). Constraints outlive the turns they were stated in.
2. **Key concepts and decisions** — domain facts, technical choices, and rationale established so far. Include the WHY, not just the what — a decision without its reason gets relitigated.
3. **Artifacts and files** — every file/deliverable created, modified, or read that still matters: path, its role, and a short excerpt of load-bearing content only.
4. **Errors and fixes** — problems hit and how they were resolved, including user corrections ("no, do it this way") — those are feedback with lasting force.
5. **All user messages** — a chronological list of every user message (trimmed of pasted bulk). This is the intent audit-trail.
6. **Pending tasks** — explicitly incomplete items, promised follow-ups, things the user said "later" about.
7. **Current work** — precisely what was in progress at this point: which step, which file, what state.
8. **Next step** — the immediate next action, justified by the user's request.

Rules:
- Do NOT carry full file contents as truth. Note THAT a file was read/edited; the coworker re-reads if it needs the content again. Stale memory of a file is worse than no memory.
- Be concrete: paths, names, commands, ids — not vague references.
- Output only the summary sections, no preamble.`;

const CONTINUATION_CONTRACT =
  "Continue where you left off: pick up the current work and next step exactly as " +
  "described. Do not re-ask answered questions, do not recap, do not mention that the " +
  "context was compacted. If you need the contents of a file noted above, re-read it.";

/** The summarized span as compact text for the summarizer. Tool results are clipped hard
 * (first casualty); if the whole render still exceeds the budget, oldest lines are dropped —
 * the newest context is the most load-bearing. */
function renderSpan(span: ChatMessage[], budgetChars: number = SPAN_BUDGET_CHARS): string {
  const lines: string[] = [];
  for (const msg of span) {
    if (msg.role === "system" || msg.role === "notice") continue;
    if (msg.role === "tool") {
      let text = textOf(msg.content).split(/\s+/).filter(Boolean).join(" ");
      if (text.length > SPAN_TOOL_RESULT_CLIP) text = text.slice(0, SPAN_TOOL_RESULT_CLIP - 1) + "…";
      lines.push(`[tool result] ${text}`);
      continue;
    }
    const text = textOf(msg.content);
    if (msg.role === "assistant") {
      for (const tc of msg.toolCalls ?? []) {
        let args = (tc.function.arguments || "").split(/\s+/).filter(Boolean).join(" ");
        if (args.length > 200) args = args.slice(0, 199) + "…";
        lines.push(`[assistant → ${tc.function.name}] ${args}`);
      }
      if (text) lines.push(`[assistant] ${text}`);
    } else if (msg.role === "user") {
      lines.push(`[user] ${text}`);
    }
  }
  let rendered = lines.join("\n");
  if (rendered.length > budgetChars) {
    rendered = "(…oldest turns elided…)\n" + rendered.slice(-budgetChars);
  }
  return rendered;
}

/** The provider-ready messages for the summarizer call. On repeated compaction the prior
 * summary heads the new span — folded in via text, not replay, since its sidecars vanish
 * along with the messages they came from. */
function summarizerMessages(span: ChatMessage[], priorSummary: string): ChatMessage[] {
  let body = renderSpan(span);
  if (priorSummary) {
    body =
      "[previous compaction summary — fold its still-relevant content into the new summary]\n" +
      priorSummary +
      "\n\n[conversation since]\n" +
      body;
  }
  return [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: body },
  ];
}

/** One summarizer round-trip. Tools off; `max_tokens` rides in `settings` since
 * CompletionRequest has no dedicated field. Throws on provider failure or an empty summary —
 * the caller (createCompactionHook) owns the fail-open policy. */
async function summarizeSpan(
  provider: ProviderClient,
  model: string,
  span: ChatMessage[],
  priorSummary: string,
): Promise<string> {
  const turn = await provider.complete({
    model,
    messages: summarizerMessages(span, priorSummary),
    settings: { max_tokens: SUMMARY_MAX_TOKENS },
  });
  const text = (turn.text ?? "").trim();
  if (!text) throw new Error("summarizer returned an empty summary");
  return text;
}

// -- building + applying a compaction ------------------------------------------------------

interface CompactionState {
  summaryText: string;
  workingState: string;
  userMessages: string[];
  userMessagesDropped: number;
  createdAt: number;
  modelUsed: string;
}

interface PriorCompactionState {
  summaryText: string;
  userMessages: string[];
  userMessagesDropped: number;
}

/** Read a prior compaction's foldable state back off the leading marker message, if any
 * (see the module docstring — sidecars stand in for Python's caller-owned CompactionState
 * store). */
function extractPriorState(messages: ChatMessage[]): PriorCompactionState | null {
  const boundary = firstTurnIndex(messages);
  for (let i = 0; i < boundary; i++) {
    const msg = messages[i];
    if (msg.kind !== COMPACTION_KIND) continue;
    return {
      summaryText: typeof msg.summaryText === "string" ? msg.summaryText : "",
      userMessages: Array.isArray(msg.userMessages) ? msg.userMessages.map((u) => String(u)) : [],
      userMessagesDropped: typeof msg.userMessagesDropped === "number" ? msg.userMessagesDropped : 0,
    };
  }
  return null;
}

/** The single outbound message standing in for everything before the boundary. */
function compactedBlockText(state: CompactionState): string {
  const parts = [
    "<compacted-history>",
    "Earlier turns of this session were compacted. The summary below is your memory of them.",
    "",
    state.summaryText,
  ];
  if (state.workingState) parts.push("", state.workingState);
  if (state.userMessages.length) {
    parts.push("", "## User messages in the compacted span (verbatim, chronological)");
    if (state.userMessagesDropped) {
      parts.push(
        `(${state.userMessagesDropped} earlier user messages omitted — their intent is covered by the summary above)`,
      );
    }
    parts.push(...state.userMessages.map((u) => `- ${u}`));
  }
  parts.push("", CONTINUATION_CONTRACT, "</compacted-history>");
  return parts.join("\n");
}

function makeCompactionMessage(state: CompactionState): ChatMessage {
  return {
    role: "system",
    kind: COMPACTION_KIND,
    content: compactedBlockText(state),
    ts: state.createdAt,
    // Sidecars only — not read by any provider, folded back in by extractPriorState() on a
    // later compaction pass.
    summaryText: state.summaryText,
    userMessages: state.userMessages,
    userMessagesDropped: state.userMessagesDropped,
    modelUsed: state.modelUsed,
  };
}

interface BuiltCompaction {
  boundary: number;
  state: CompactionState;
}

/** Summarize everything older than the picked boundary. Null when there is nothing to
 * compact; throws when the summarizer fails (createCompactionHook applies fail-open policy). */
async function buildState(
  messages: ChatMessage[],
  provider: ProviderClient,
  model: string,
  keepTokens: number,
  prior: PriorCompactionState | null,
): Promise<BuiltCompaction | null> {
  const boundary = pickBoundary(messages, keepTokens);
  if (boundary === null) return null;
  const span = messages.slice(firstTurnIndex(messages), boundary);
  const summary = await summarizeSpan(provider, model, span, prior?.summaryText ?? "");
  const [userMessages, userMessagesDropped] = capUserMessages(
    [...(prior?.userMessages ?? []), ...extractUserMessages(span)],
    prior?.userMessagesDropped ?? 0,
  );
  return {
    boundary,
    state: {
      summaryText: summary,
      workingState: extractWorkingState(span),
      userMessages,
      userMessagesDropped,
      createdAt: Date.now(),
      modelUsed: model,
    },
  };
}

/** [instructions?] + the compacted block + the verbatim tail. The array passed in is never
 * mutated — this always returns a fresh array. */
function applyState(messages: ChatMessage[], boundary: number, state: CompactionState): ChatMessage[] {
  const head: ChatMessage[] = [];
  const first = messages[0];
  if (first && first.role === "system" && first.kind !== COMPACTION_KIND) head.push(first);
  head.push(makeCompactionMessage(state));
  return [...head, ...messages.slice(boundary)];
}

// -- public factory -----------------------------------------------------------------------------

/**
 * Build a `CompactionHook` bound to one provider/model/window. Each call: estimate tokens,
 * check `shouldCompact()`, and either return `messages` unchanged (by reference) or summarize
 * everything older than `pickBoundary()` and return a new array with that span replaced by a
 * single leading message.
 */
export function createCompactionHook(opts: CreateCompactionHookOptions): CompactionHook {
  const thresholdPct = opts.thresholdPct ?? DEFAULT_THRESHOLD_PCT;
  const capTokens = opts.capTokens ?? DEFAULT_CAP_TOKENS;

  return async (messages: ChatMessage[]): Promise<ChatMessage[]> => {
    const signal = estimateTokens(messages);
    if (!shouldCompact(signal, opts.contextWindow, { thresholdPct, capTokens })) {
      return messages;
    }

    const trigger = triggerTokens(opts.contextWindow, { thresholdPct, capTokens });
    const keepTokens = Math.floor(trigger * KEEP_RECENT_FRACTION);
    const prior = extractPriorState(messages);

    let built: BuiltCompaction | null;
    try {
      built = await buildState(messages, opts.provider, opts.model, keepTokens, prior);
    } catch {
      // Fail open — see the module docstring: engine.ts's loop() does not try/catch this
      // call, so throwing here would abort the whole turn with no `error` event.
      return messages;
    }
    if (!built) return messages;
    return applyState(messages, built.boundary, built.state);
  };
}
