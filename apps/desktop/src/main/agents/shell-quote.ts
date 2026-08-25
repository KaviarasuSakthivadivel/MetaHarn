/**
 * Single-quotes a string for safe inclusion in the shell line `pty.ts`
 * types into the terminal (see spawnPty — commands are literally written
 * as keystrokes into a real shell, not passed as argv). Needed once
 * seed prompts (LLM-generated handoff summaries, not user input, but still
 * arbitrary text that can contain quotes/newlines) started getting typed
 * in as command arguments — standard technique: wrap in single quotes,
 * escape any embedded single quote as '\''.
 */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
