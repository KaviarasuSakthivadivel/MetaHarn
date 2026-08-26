/**
 * Shell-command allowlist matcher — decides whether a (possibly compound) shell command is
 * fully covered by a set of user-configured command prefixes, so the permission engine can
 * auto-run it without asking.
 *
 * Ported from OpenWorker's coworker/permissions.py `_command_allowed` / `_split_commands` /
 * `_is_prefix_eligible` (see the docstring on `_command_allowed` there for the full
 * rationale). Deliberately dependency-free and standalone: no imports, pure string
 * functions, no knowledge of `PermissionEngine` or any other module in this package.
 *
 * Node has no `shlex`, so this file carries its own small POSIX-ish tokenizer
 * (`shlexSplit`) instead of pulling one in.
 */

// Constructs whose *contents* we cannot evaluate, so a command carrying one is never
// eligible for prefix auto-run: command/process substitution, redirection (writes anywhere
// the allowlist never vetted), variable expansion (the value was set out of view), and
// subshells. A plain substring check on purpose — see `_command_allowed`'s docstring.
const OPAQUE_CONSTRUCTS = ["`", "$(", "$", ">", "<", "("];

// Separators that chain several commands into one string. Longest first so "&&" isn't read
// as two "&"s, and "|&"/"||" aren't read as a "|" plus a leftover.
const SEPARATORS = ["&&", "||", ";", "|&", "|", "&", "\n", "\r"];

// Programs that run *another* program named in their arguments. A prefix rule on the outer
// program can never vouch for the inner one, so these always fall through to approval.
const ARG_EXECUTORS = new Set([
  "xargs", "env", "nohup", "nice", "stdbuf", "timeout", "watch", "sudo", "doas",
  "ssh", "docker", "podman", "kubectl", "npx", "pnpx", "bunx", "uvx",
]);

// Interpreters carrying inline code, e.g. `python -c "..."`, `node -e "..."`.
const INLINE_CODE_FLAGS = new Set(["-c", "-e", "--eval", "--command", "-Command", "-EncodedCommand"]);
const INTERPRETERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "powershell", "pwsh", "cmd",
  "python", "python3", "node", "deno", "bun", "ruby", "perl", "php",
]);

// Flags that turn a search/list tool into an execution or deletion tool.
const DANGEROUS_FLAGS = new Set(["-exec", "-execdir", "-delete", "-ok", "-okdir", "-fprintf"]);

/** Split a compound command on its separators. Purely textual — quoted separators are not
 * respected, which is deliberate: over-splitting only ever produces MORE parts to justify,
 * never fewer. */
function splitCommands(command: string): string[] {
  let parts = [command];
  for (const sep of SEPARATORS) {
    const next: string[] = [];
    for (const part of parts) next.push(...part.split(sep));
    parts = next;
  }
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Last path segment, lowercased, `.exe` stripped — mirrors `Path(argv[0]).name.lower()`. */
function programName(head: string): string {
  const idx = Math.max(head.lastIndexOf("/"), head.lastIndexOf("\\"));
  let name = (idx === -1 ? head : head.slice(idx + 1)).toLowerCase();
  if (name.endsWith(".exe")) name = name.slice(0, -4);
  return name;
}

/** False when a parsed command can never be vouched for by a prefix rule, because it runs
 * code the rule never saw: another program named in its arguments, inline source, or an
 * execution/deletion flag. */
function isPrefixEligible(argv: string[]): boolean {
  if (argv.length === 0) return false;
  const program = programName(argv[0]);
  if (ARG_EXECUTORS.has(program)) return false;
  const rest = argv.slice(1);
  if (INTERPRETERS.has(program) && rest.some((a) => INLINE_CODE_FLAGS.has(a))) return false;
  if (rest.some((a) => DANGEROUS_FLAGS.has(a.toLowerCase()))) return false;
  return true;
}

/**
 * A small POSIX-ish `shlex.split` equivalent: splits on whitespace, honors single quotes
 * (literal) and double quotes (backslash-escapes `\`, `"`, `$`, backtick, newline inside),
 * and lets an unquoted backslash escape the next character. Returns `null` on unbalanced
 * quotes/trailing backslash — the caller treats that as "not allowlisted", same as Python's
 * `shlex.split` raising `ValueError`.
 *
 * No punctuation-run grouping (unlike readonlyClassifier's tokenizer): by the time this runs
 * the input is either an already-separator-split command part (which can't contain a raw
 * shell operator — the opaque-construct check upstream rejects `>`/`<`/`(`/`$` outright) or
 * one entry from the user's own allowlist config.
 */
function shlexSplit(input: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let hasToken = false;
  const n = input.length;
  let i = 0;

  while (i < n) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(cur);
        cur = "";
        hasToken = false;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      hasToken = true;
      i++;
      const start = i;
      while (i < n && input[i] !== "'") i++;
      if (i >= n) return null;
      cur += input.slice(start, i);
      i++;
      continue;
    }
    if (ch === '"') {
      hasToken = true;
      i++;
      while (i < n && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < n && '"\\$`\n'.includes(input[i + 1])) {
          cur += input[i + 1];
          i += 2;
        } else {
          cur += input[i];
          i++;
        }
      }
      if (i >= n) return null;
      i++;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= n) return null;
      hasToken = true;
      cur += input[i + 1];
      i += 2;
      continue;
    }
    hasToken = true;
    cur += ch;
    i++;
  }
  if (hasToken) tokens.push(cur);
  return tokens;
}

/**
 * True only when EVERY part of a (possibly compound) command is independently covered by an
 * allowlist entry.
 *
 * An allowlist entry auto-runs without approval, and a prefix rule can only vouch for the
 * words it matched — everything after is unexamined. So this does two jobs: guarantee the
 * unexamined tail can only be arguments, then match the beginning.
 *
 * - Constructs whose contents we can't evaluate (substitution, redirection, variable
 *   expansion, subshells) disqualify the whole command.
 * - Compound commands are split and each part checked on its own, so
 *   `git status && git diff` runs when both are allowed, while
 *   `git status && rm -rf ~` does not.
 * - Parts that run code named in their arguments (`xargs`, `sh -c`, `find -exec`, `-delete`)
 *   are never prefix-eligible: a `find` rule must not auto-run `find . -exec rm {} +`.
 * - Matching is on parsed words, not text, so `git status` covers `git status -s` but never
 *   `git statusfoo` or a bare `git`.
 */
export function isCommandAllowed(command: string, allowedCommands: string[]): boolean {
  if (!command.trim()) return false;
  if (OPAQUE_CONSTRUCTS.some((tok) => command.includes(tok))) return false;

  const parts = splitCommands(command);
  if (parts.length === 0) return false;

  const prefixes: string[][] = [];
  for (const allowed of allowedCommands) {
    const prefix = shlexSplit(allowed);
    if (prefix === null) continue;
    if (prefix.length > 0) prefixes.push(prefix);
  }
  if (prefixes.length === 0) return false;

  for (const part of parts) {
    const argv = shlexSplit(part);
    if (argv === null) return false; // unbalanced quotes etc. — treat as not-allowlisted
    if (argv.length === 0 || !isPrefixEligible(argv)) return false;
    const matched = prefixes.some(
      (prefix) => prefix.length <= argv.length && prefix.every((tok, i) => argv[i] === tok),
    );
    if (!matched) return false;
  }
  return true;
}
