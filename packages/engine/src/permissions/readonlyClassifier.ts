/**
 * Conservative read-only shell-command classifier for the session-scoped "allow read-only
 * commands" grant.
 *
 * Ported from OpenWorker's coworker/readonly.py. The contract (unchanged from there):
 *
 * - **Local filesystem reads only.** Network clients (curl/wget/ssh/nc) are deliberately
 *   excluded even for GET — an auto-allowed network command is an exfiltration channel
 *   under prompt injection. Interpreters (python/ruby/sh -c) and anything that can write,
 *   execute, or mutate are excluded.
 * - **Pipelines are allowed** (`nl … | sed -n … | grep …`) — every stage must classify. All
 *   other shell operators (;, &&, ||, &, redirections, substitutions) are rejected outright.
 * - **Fail closed.** Unknown commands, unparseable input, path-invoked binaries, and any
 *   doubtful flag reject. False negatives cost one manual approval; false positives cost an
 *   unreviewed side effect — the asymmetry decides every edge case here.
 *
 * Standalone and dependency-free: no imports, pure string functions. In particular this file
 * does NOT share a tokenizer with `shellAllowlist.ts` — the two need different tokenization
 * (this one must surface `>`, `<`, `&`, etc. as their own tokens to catch inline redirection
 * like `cat f>out`; `shellAllowlist.ts` never sees such characters, since its opaque-construct
 * check rejects them before tokenizing ever starts).
 */

// Commands that only read local state, with no writing flags to police.
const SIMPLE_SAFE = new Set([
  "ls", "cat", "head", "tail", "wc", "nl", "sort", "uniq", "cut", "tr",
  "grep", "egrep", "fgrep", "rg", "ugrep", "file", "stat", "du", "df",
  "pwd", "echo", "printf", "which", "whoami", "id", "date", "uname",
  "basename", "dirname", "realpath", "readlink", "jq", "column", "diff",
  "comm", "strings", "md5sum", "shasum", "sha1sum", "sha256sum",
  "hexdump", "xxd", "od", "true", "false", "yamllint", "actionlint",
]);

// Git subcommands that only read. Several git "read" commands grow write/exec behavior
// through specific flags — see the per-subcommand guards in `gitOk`.
const GIT_SAFE = new Set([
  "status", "log", "show", "diff", "blame", "shortlog", "describe",
  "rev-parse", "rev-list", "ls-files", "ls-tree", "grep", "cat-file",
  "name-rev", "merge-base", "count-objects", "var", "check-ignore",
]);

const GIT_BRANCH_FLAG_OK = new Set([
  "--show-current", "--list", "-a", "-r", "-v", "-vv", "--contains",
  "--merged", "--no-merged", "--all",
]);

const GIT_TAG_FLAG_OK = new Set(["-l", "--list", "-n", "--contains", "--merged"]);
const GIT_CONFIG_FLAG_OK = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"]);

const FIND_BAD = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fls", "-fprintf"];

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=[^;&|<>`]*$/;

// A sed script token that invokes the `w`/`W` (write-file) command: at the start, after a
// separator, or after an address. Conservative — a false hit just means one manual approval.
const SED_WRITE = /(^|[;{])\s*[0-9,$/ ]*[wW]\s/;

// Operands are not paths: arguments are strings, charsets, or command names.
const NO_PATH_OPERANDS = new Set([
  "echo", "printf", "pwd", "whoami", "id", "date", "uname", "true", "false",
  "which", "basename", "dirname", "tr", "command", "env",
]);
// The FIRST non-flag operand is a pattern/program, not a path; the rest are files.
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "ugrep", "jq", "awk", "gawk", "mawk", "nawk", "sed"]);
// Flags whose VALUE is a path, for the commands that accept them.
const PATH_VALUE_FLAGS = new Set(["-f", "--file", "--exclude-from", "--include-from"]);
// `head -n 5`, `cut -f 1`, `sed -n 2p`: a bare number is some flag's count, never a file
// worth scoping. Dropping them keeps the target list honest without a per-flag table.
const NUMERIC = /^[0-9]+([,:.-][0-9]+)*[a-zA-Z]?$/;

// shlex's default `punctuation_chars` set: characters tokenized as their own run, separate
// from surrounding word characters, so `cat f>out` yields ["cat", "f", ">", "out"] rather
// than one opaque word "f>out".
const PUNCT_CHARS = new Set(["(", ")", ";", "<", ">", "|", "&"]);

// Tokens that unconditionally reject (everything except a plain pipe): `;`, `&`, `&&`,
// `||`, `|&` outright, plus any punctuation-only run built from redirection/background
// characters (`>`, `>>`, `2>`, `&>`, `<<`, …) — a token made only of `<`/`>`/`&`/digits that
// contains at least one of `<`, `>`, `&`.
const OPERATOR_REJECT_EXACT = new Set([";", "&", "&&", "||", "|&"]);
const OPERATOR_SUBSET_CHARS = new Set([">", "<", "&", "0", "1", "2"]);

function envAssignPrefixLength(argv: string[]): number {
  let i = 0;
  while (i < argv.length && ENV_ASSIGN.test(argv[i])) i++;
  return i;
}

/**
 * Punctuation-aware tokenizer (shlex with `punctuation_chars=True`, `whitespace_split=True`
 * equivalent): whitespace splits tokens, quotes behave as in POSIX shells, and a maximal run
 * of characters from `PUNCT_CHARS` is always its own token — even glued directly onto a word
 * with no space (`f>out`, `2>&1`). Returns `null` on unbalanced quotes/trailing backslash.
 */
function tokenizePunctuationAware(command: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let hasToken = false;
  let curIsOperator = false;
  const n = command.length;
  let i = 0;

  const flush = (): void => {
    if (hasToken) {
      tokens.push(cur);
      cur = "";
      hasToken = false;
      curIsOperator = false;
    }
  };

  while (i < n) {
    const ch = command[i];
    if (/\s/.test(ch)) {
      flush();
      i++;
      continue;
    }
    if (ch === "'") {
      if (curIsOperator) flush();
      hasToken = true;
      curIsOperator = false;
      i++;
      const start = i;
      while (i < n && command[i] !== "'") i++;
      if (i >= n) return null;
      cur += command.slice(start, i);
      i++;
      continue;
    }
    if (ch === '"') {
      if (curIsOperator) flush();
      hasToken = true;
      curIsOperator = false;
      i++;
      while (i < n && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < n && '"\\$`\n'.includes(command[i + 1])) {
          cur += command[i + 1];
          i += 2;
        } else {
          cur += command[i];
          i++;
        }
      }
      if (i >= n) return null;
      i++;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= n) return null;
      if (curIsOperator) flush();
      hasToken = true;
      curIsOperator = false;
      cur += command[i + 1];
      i += 2;
      continue;
    }
    if (PUNCT_CHARS.has(ch)) {
      if (hasToken && !curIsOperator) flush();
      hasToken = true;
      curIsOperator = true;
      cur += ch;
      i++;
      continue;
    }
    if (hasToken && curIsOperator) flush();
    hasToken = true;
    curIsOperator = false;
    cur += ch;
    i++;
  }
  flush();
  return tokens;
}

/** Tokenize with operators surfaced; split into pipeline stages. `null` = reject. */
function stages(command: string): string[][] | null {
  if (!command || !command.trim()) return null;
  // Substitutions can hide inside double quotes, which the tokenizer strips — check the raw
  // text. Rejects a literal '$(' in a grep pattern too; that asymmetry is the point.
  if (command.includes("`") || command.includes("$(") || command.includes("<(") || command.includes(">(")) {
    return null;
  }
  const tokens = tokenizePunctuationAware(command);
  if (tokens === null) return null;

  const out: string[][] = [[]];
  for (const tok of tokens) {
    if (tok === "|") {
      out.push([]);
      continue;
    }
    const isRejectOperator =
      OPERATOR_REJECT_EXACT.has(tok) ||
      (tok.length > 0 &&
        [...tok].every((c) => OPERATOR_SUBSET_CHARS.has(c)) &&
        [...tok].some((c) => c === "<" || c === ">" || c === "&"));
    if (isRejectOperator) return null; // every operator except a plain pipe rejects
    out[out.length - 1].push(tok);
  }
  if (out.some((s) => s.length === 0)) return null; // empty stage ("| cmd", "cmd |")
  return out;
}

function gitOk(args: string[]): boolean {
  // Global flags: only `-C <dir>` and `--no-pager` pass; `-c`/`--config-env` can set
  // core.pager and similar exec hooks — rejected.
  let i = 0;
  while (i < args.length) {
    if (args[i] === "-C" && i + 1 < args.length) {
      i += 2;
      continue;
    }
    if (args[i] === "--no-pager") {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= args.length) return false;
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (rest.some((t) => t.startsWith("--output"))) return false; // git log/diff --output=<file> writes
  if (GIT_SAFE.has(sub)) return true;
  if (sub === "branch") {
    return rest.every((t) => GIT_BRANCH_FLAG_OK.has(t) || t.startsWith("--format=") || t.startsWith("--sort="));
  }
  if (sub === "tag") {
    return rest.length > 0 && rest.every((t) => GIT_TAG_FLAG_OK.has(t) || t.startsWith("-n"));
  }
  if (sub === "stash") {
    return rest.length > 0 && (rest[0] === "list" || rest[0] === "show");
  }
  if (sub === "remote") {
    return rest.length === 0 || rest[0] === "-v" || rest[0] === "show" || rest[0] === "get-url";
  }
  if (sub === "config") {
    return rest.some((t) => GIT_CONFIG_FLAG_OK.has(t));
  }
  if (sub === "reflog") {
    return rest.length === 0 || rest[0] === "show";
  }
  return false;
}

function stageOk(argvIn: string[]): boolean {
  // Leading VAR=value assignments (LC_ALL=C grep …) are inert — skip them.
  const argv = argvIn.slice(envAssignPrefixLength(argvIn));
  if (argv.length === 0) return false;
  const head = argv[0];
  if (head.includes("/")) return false; // path-invoked binaries can be anything; bare names only
  const args = argv.slice(1);
  if (SIMPLE_SAFE.has(head)) return true;
  if (head === "env") return args.length === 0; // bare `env` prints; `env CMD` executes
  if (head === "command") return args.length > 0 && (args[0] === "-v" || args[0] === "-V");
  if (head === "git") return gitOk(args);
  if (head === "sed") {
    if (args.some((t) => t.startsWith("-i") || t.startsWith("--in-place") || t.startsWith("-f") || t.startsWith("--file"))) {
      return false;
    }
    return !args.some((t) => !t.startsWith("-") && SED_WRITE.test(t));
  }
  if (head === "awk" || head === "gawk" || head === "mawk" || head === "nawk") {
    return !args.some((t) => t.includes(">") || t.includes("system"));
  }
  if (head === "find") {
    return !args.some((t) => FIND_BAD.some((bad) => t.startsWith(bad)));
  }
  return false;
}

/** True iff `command` is a single command or pure pipeline of local read-only stages. */
export function isReadonlyCommand(command: string): boolean {
  const parsed = stages(String(command ?? ""));
  if (parsed === null) return false;
  return parsed.every((s) => stageOk(s));
}

// -- read targets (OPE-130) ------------------------------------------------------------
// The classifier above decides what a command may DO. It says nothing about what the
// command may READ, so a session grant meant for "stop asking about my project files" would
// also cover ~/.aws/credentials, ~/.ssh/id_rsa, etc. These helpers name the file operands so
// the caller can hold them to the session's roots.
//
// Extracting read targets from arbitrary shell is not possible in general; it is tractable
// here only because the classifier has already narrowed the input to the verbs above. Only
// meaningful for commands `isReadonlyCommand` accepts.

function stageTargets(argvIn: string[]): string[] {
  const argv = argvIn.slice(envAssignPrefixLength(argvIn));
  if (argv.length === 0) return [];
  const head = argv[0];
  const args = argv.slice(1);
  if (NO_PATH_OPERANDS.has(head)) return [];

  if (head === "git") {
    // Only `-C <dir>` escapes the working directory; everything else the classifier accepts
    // reads the repo already in scope. Operands after `--` are pathspecs.
    const out: string[] = [];
    for (let j = 0; j < args.length; j++) {
      const tok = args[j];
      if (tok === "-C" && j + 1 < args.length) {
        out.push(args[j + 1]);
      } else if (tok === "--") {
        for (const t of args.slice(j + 1)) {
          if (!t.startsWith("-")) out.push(t);
        }
        break;
      }
    }
    return out;
  }

  const out: string[] = [];
  let skipNext = false;
  let seenOperand = false;
  for (const tok of args) {
    if (skipNext) {
      // `-f` is a pattern FILE for grep but a field NUMBER for cut; the numeric test
      // separates them without needing a per-command flag table.
      if (!NUMERIC.test(tok)) out.push(tok);
      // `grep -f patterns.txt build.log`: the pattern came from the flag, so the first
      // positional is already a FILE and must not be skipped as the pattern.
      seenOperand = true;
      skipNext = false;
      continue;
    }
    if (tok.startsWith("-")) {
      if (PATH_VALUE_FLAGS.has(tok)) {
        skipNext = true;
      } else if (head === "find") {
        break; // find's predicates start here; paths precede them
      }
      continue;
    }
    if (PATTERN_FIRST.has(head) && !seenOperand) {
      seenOperand = true; // the pattern/script/filter, not a file
      continue;
    }
    seenOperand = true;
    if (!NUMERIC.test(tok)) out.push(tok);
  }
  return out;
}

/**
 * Every file operand `command` would read, for scoping against the session's roots.
 *
 * Only meaningful for commands `isReadonlyCommand` accepts — it assumes that vetting. Errs
 * toward naming MORE operands: an extra one costs a manual approval, a missed one is an
 * unscoped read, and that asymmetry decides the edge cases here as it does above.
 *
 * Known limit: a path reached through a flag this table does not list is not returned. The
 * positional operands that carry the real exposure are covered.
 */
export function readTargets(command: string): string[] {
  const parsed = stages(String(command ?? ""));
  if (parsed === null) return [];
  const out: string[] = [];
  for (const stage of parsed) out.push(...stageTargets(stage));
  return out;
}
