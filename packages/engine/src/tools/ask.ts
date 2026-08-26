/**
 * `ask_user` — the agent asks the user one or more questions and waits for the answer.
 *
 * Ported from OpenWorker's coworker/tools/ask.py. There the TurnEngine intercepts the call
 * (the question becomes an out-of-band Inbox item; the agent suspends until it's resolved);
 * this engine has no per-tool UI slot, so the real work is an injected async callback the
 * factory closes over. With no callback (a headless surface) execute() returns the same
 * fallback shape the Python original returns — it never throws.
 *
 * OPE-51 shape carried over: options may be plain strings or rich objects
 * ({label, description, recommended, preview}), and up to MAX_GROUPED_QUESTIONS questions can
 * be grouped into one call via `questions` (rendered as a stepper — one round-trip instead of
 * several). Unlike ask.py, options handed to the callback are always fully normalized to rich
 * objects (no plain-string passthrough) — there's no legacy Inbox renderer here to stay
 * compatible with, so the callback always sees one canonical shape.
 */
import type { ToolDefinition, ToolSchema } from "../types.js";

/** How many questions one grouped call may carry (stepper chips get unreadable past this). */
export const MAX_GROUPED_QUESTIONS = 4;

/** One quick-reply choice. `label` is both the button text and the answer value. */
export interface AskUserOption {
  label: string;
  description?: string;
  recommended?: boolean;
  preview?: string;
}

/** An option as it may arrive from the model: a plain string, or the rich object above. */
export type AskUserOptionInput = string | Partial<AskUserOption>;

/** One entry of a grouped (`questions`) call, already normalized. */
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options?: AskUserOption[];
  allowText: boolean;
  multi: boolean;
}

/** Normalized question(s) handed to the injected `ask` callback. */
export interface AskUserQuestion {
  /** Single-question form. Empty when `questions` (grouped form) is used instead. */
  question: string;
  options?: AskUserOption[];
  allowText: boolean;
  multi: boolean;
  header?: string;
  /** Grouped form: up to MAX_GROUPED_QUESTIONS questions asked in one round-trip. Empty for
   * the single-question form. */
  questions: AskUserQuestionItem[];
}

/** What the callback resolves with. Single form -> `answer`; grouped form -> `answers` keyed
 * by each question's header (falling back to its question text). */
export interface AskUserAnswer {
  answer?: string;
  answers?: Record<string, string>;
  error?: string;
}

const ASK_USER_OPTION_SCHEMA = {
  anyOf: [
    { type: "string" },
    {
      type: "object",
      properties: {
        label: { type: "string" },
        description: { type: "string" },
        recommended: { type: "boolean" },
        preview: { type: "string" },
      },
      required: ["label"],
    },
  ],
};

const ASK_USER_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "ask_user",
    description:
      "Ask the user one or more questions and wait for their answer. Use for decisions or " +
      "information only the user can provide. Do not use it to ask permission for a specific " +
      "action you are about to take — propose the action instead; the approval flow shows " +
      "the user exactly what would run and does the asking. Group related questions (up to " +
      `${MAX_GROUPED_QUESTIONS}) into one call via \`questions\` instead of asking serially.`,
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The full question, in plain language (single-question form).",
        },
        options: {
          type: "array",
          items: ASK_USER_OPTION_SCHEMA,
          description:
            "Optional quick-reply choices: plain strings, or objects with `label` (required — " +
            "this is the answer value), `description` (why/when to pick it), `recommended` " +
            "(green tag; list that option first), and `preview` (monospace text — code, " +
            "config, a mockup — shown in a side pane).",
        },
        allow_text: {
          type: "boolean",
          description:
            "Keep a free-text answer available even when options exist (default true; the " +
            '"Other / type your own" escape). Set false only when the options are exhaustive.',
        },
        multi: { type: "boolean", description: "Allow the user to pick more than one option." },
        header: {
          type: "string",
          description: 'Short (≤ ~12 char) chip label for the card, e.g. "Region".',
        },
        questions: {
          type: "array",
          maxItems: MAX_GROUPED_QUESTIONS,
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              header: {
                type: "string",
                description:
                  "Short (≤ ~12 char) label — names this step in the stepper chips and keys " +
                  "its answer in the result.",
              },
              options: { type: "array", items: ASK_USER_OPTION_SCHEMA },
              allow_text: { type: "boolean" },
              multi: { type: "boolean" },
            },
            required: ["question"],
          },
          description:
            `Grouped form: up to ${MAX_GROUPED_QUESTIONS} questions asked in ONE round-trip, ` +
            "rendered as a stepper. When set, the singular question/options fields are ignored.",
        },
      },
      required: [],
    },
  },
};

/** One option in canonical form — mirrors ask.py's `normalize_option`. Plain strings become
 * `{label: str}` with everything else left unset. */
export function normalizeAskUserOption(opt: AskUserOptionInput): AskUserOption {
  if (typeof opt === "string") return { label: opt };
  return {
    label: String(opt.label ?? ""),
    ...(opt.description !== undefined ? { description: String(opt.description) } : {}),
    ...(opt.recommended !== undefined ? { recommended: Boolean(opt.recommended) } : {}),
    ...(opt.preview !== undefined ? { preview: String(opt.preview) } : {}),
  };
}

function normalizeOptions(raw: unknown): AskUserOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((o) => normalizeAskUserOption(o as AskUserOptionInput));
}

/** The grouped `questions` arg in canonical form (capped at MAX_GROUPED_QUESTIONS, blank
 * questions dropped) — mirrors ask.py's `normalize_questions`. */
export function normalizeAskUserQuestions(raw: unknown): AskUserQuestionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AskUserQuestionItem[] = [];
  for (const entry of raw.slice(0, MAX_GROUPED_QUESTIONS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const question = String(e.question ?? "").trim();
    if (!question) continue;
    const options = normalizeOptions(e.options);
    out.push({
      question,
      ...(e.header !== undefined ? { header: String(e.header) } : {}),
      ...(options !== undefined ? { options } : {}),
      allowText: e.allow_text !== undefined ? Boolean(e.allow_text) : true,
      multi: Boolean(e.multi ?? false),
    });
  }
  return out;
}

function parseArgs(args: Record<string, unknown>): AskUserQuestion {
  const options = normalizeOptions(args.options);
  return {
    question: String(args.question ?? "").trim(),
    ...(options !== undefined ? { options } : {}),
    allowText: args.allow_text !== undefined ? Boolean(args.allow_text) : true,
    multi: Boolean(args.multi ?? false),
    ...(args.header !== undefined ? { header: String(args.header) } : {}),
    questions: normalizeAskUserQuestions(args.questions),
  };
}

/** Fallback returned when no `ask` callback is wired — mirrors ask.py's headless body. */
const NO_ASKER_FALLBACK: AskUserAnswer = {
  answer: "",
  error: "asking the user isn't available in this surface",
};

/**
 * Build the `ask_user` tool. `ask` performs the real out-of-band Q&A round-trip (e.g.
 * surfacing an Inbox item or a chat prompt and awaiting the user's resolution). When omitted
 * — a headless surface — execute() returns the same safe fallback the Python original
 * returns, and never throws; a callback that itself rejects is likewise turned into an
 * `{answer: "", error}` result rather than propagating (the engine would otherwise record it
 * as a generic tool error, losing the answer-shaped result the model expects back).
 */
export function createAskUserTool(
  ask?: (question: AskUserQuestion) => Promise<AskUserAnswer>,
): ToolDefinition {
  return {
    name: "ask_user",
    schema: ASK_USER_SCHEMA,
    metadata: {
      category: "interaction",
      riskLevel: "low",
      risk: "read",
      capabilities: ["ask_user"],
    },
    execute: async (args: Record<string, unknown>): Promise<unknown> => {
      if (!ask) return NO_ASKER_FALLBACK;
      try {
        return await ask(parseArgs(args));
      } catch (err) {
        return { answer: "", error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
