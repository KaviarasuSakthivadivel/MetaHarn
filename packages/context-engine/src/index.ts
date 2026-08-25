import { readFileSync, existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const CODEOWNERS_PATHS = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];
export const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", ".turbo"]);

export interface ContextDocOptions {
  maxTreeDepth?: number;
  maxTreeEntries?: number;
  gitLogCount?: number;
}

export function findCodeownersPath(repoPath: string): string | null {
  for (const candidate of CODEOWNERS_PATHS) {
    const full = join(repoPath, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

export function readCodeowners(repoPath: string): string | null {
  const path = findCodeownersPath(repoPath);
  if (!path) return null;
  return readFileSync(path, "utf-8");
}

interface CodeownersRule {
  pattern: string;
  regex: RegExp;
  owners: string[];
}

// CODEOWNERS patterns follow .gitignore-like semantics: "*" within a segment,
// "**" across segments, a leading "/" anchors to repo root, and (for the
// purposes of this v0 matcher) the last matching rule wins.
function patternToRegex(pattern: string): RegExp {
  let p = pattern;
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);
  if (p.endsWith("/")) p = p + "**";

  let re = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  re = re.replace(/\*\*/g, " DOUBLESTAR ");
  re = re.replace(/\*/g, "[^/]*");
  re = re.replace(/ DOUBLESTAR /g, ".*");
  re = re.replace(/\?/g, "[^/]");

  re = anchored ? `^${re}` : `(^|.*/)${re}`;
  re = `${re}($|/.*)`;
  return new RegExp(re);
}

export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || owners.length === 0) continue;
    rules.push({ pattern, regex: patternToRegex(pattern), owners });
  }
  return rules;
}

/** Returns the owners of `filePath` per CODEOWNERS (last matching rule wins), or null if unowned/no file. */
export function whoOwns(repoPath: string, filePath: string): string[] | null {
  const content = readCodeowners(repoPath);
  if (!content) return null;
  const rules = parseCodeowners(content);
  const normalized = filePath.replace(/^\/+/, "");

  let match: CodeownersRule | null = null;
  for (const rule of rules) {
    if (rule.regex.test(normalized)) match = rule;
  }
  return match ? match.owners : null;
}

function buildTree(repoPath: string, maxDepth: number, maxEntries: number): string {
  const lines: string[] = [];
  let count = 0;

  function walk(dir: string, depth: number, prefix: string) {
    if (depth > maxDepth || count >= maxEntries) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith(".") || e.name === ".github")
        .filter((e) => !IGNORE_DIRS.has(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= maxEntries) {
        lines.push(`${prefix}... (truncated)`);
        return;
      }
      lines.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      count++;
      if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1, prefix + "  ");
    }
  }

  walk(repoPath, 0, "");
  return lines.join("\n");
}

function readFirst(repoPath: string, candidates: string[]): { path: string; content: string } | null {
  for (const candidate of candidates) {
    const full = join(repoPath, candidate);
    if (existsSync(full) && statSync(full).isFile()) {
      return { path: candidate, content: readFileSync(full, "utf-8") };
    }
  }
  return null;
}

function readGitLog(repoPath: string, count: number): string | null {
  try {
    return execSync(`git log -n ${count} --pretty=format:"%h %ad %an: %s" --date=short`, {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Builds a single markdown "institutional memory" document for a repo:
 * directory tree, README, CODEOWNERS, manifest, and recent git history —
 * injected into every session as a virtual AGENTS.md (see agent.ts's
 * createMetaHarnSession). This package used to also offer a semantic-search
 * embeddings index (indexRepo/searchContext, a search_context tool, a
 * dedicated worker process) as a second, opt-in way to ground the agent;
 * it was removed after real usage data showed it was essentially unused
 * (one repo, one indexing run, ever) next to this always-on document,
 * which every session gets automatically with no user action required.
 */
export function buildContextDoc(repoPath: string, options: ContextDocOptions = {}): string {
  const { maxTreeDepth = 3, maxTreeEntries = 200, gitLogCount = 20 } = options;

  const sections: string[] = [
    `# Institutional context: ${repoPath}`,
    "This document is generated by MetaHarn's context engine and injected into the agent's " +
      "context for this session. It is not a real repo file — treat it as ground truth about " +
      "this project's structure, ownership, and history.",
  ];

  const readme = readFirst(repoPath, ["README.md", "README.markdown", "README.txt", "README"]);
  if (readme) sections.push(`## README (${readme.path})\n\n${readme.content}`);

  const codeowners = readCodeowners(repoPath);
  if (codeowners) sections.push(`## CODEOWNERS\n\n\`\`\`\n${codeowners}\n\`\`\``);

  const manifest = readFirst(repoPath, ["package.json"]);
  if (manifest) sections.push(`## Manifest (${manifest.path})\n\n\`\`\`json\n${manifest.content}\n\`\`\``);

  const tree = buildTree(repoPath, maxTreeDepth, maxTreeEntries);
  if (tree) sections.push(`## Directory tree (depth <= ${maxTreeDepth})\n\n\`\`\`\n${tree}\n\`\`\``);

  const gitLog = readGitLog(repoPath, gitLogCount);
  if (gitLog) sections.push(`## Recent history (last ${gitLogCount} commits)\n\n\`\`\`\n${gitLog}\n\`\`\``);

  return sections.join("\n\n");
}
