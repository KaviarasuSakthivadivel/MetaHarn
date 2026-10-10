#!/usr/bin/env node
// Repeatable version-bump helper for cutting a MetaHarn release.
//
// What it does (see docs/RELEASING.md for the full release flow this is
// one step of):
//   1. Writes the given version into every workspace's package.json
//      ("version" field) plus apps/web/src-tauri/tauri.conf.json's own
//      top-level "version" field.
//   2. Moves CHANGELOG.md's "## [Unreleased]" section content under a new
//      "## [X.Y.Z] - <today>" heading, leaving a fresh empty [Unreleased]
//      section above it, and rewrites the compare-link footer so the new
//      version and the (now stale) [Unreleased] link both point at the
//      right tags.
//
// What it deliberately does NOT do: run git. No commit, no tag, no push —
// this only edits files on disk, so the diff can be reviewed before any of
// that happens. See the printed "Next steps" at the end.
//
// Usage:
//   node scripts/bump-version.mjs <version>
//   npm run release:version -- <version>
//
// Example:
//   node scripts/bump-version.mjs 0.1.1

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");

function fail(message) {
  console.error(`[metaharn] ${message}`);
  process.exit(1);
}

const rawVersion = process.argv[2];
if (!rawVersion) {
  fail(
    "missing version argument.\n\nUsage: node scripts/bump-version.mjs <version>\nExample: node scripts/bump-version.mjs 0.1.1",
  );
}

// Plain semver (X.Y.Z), optionally with a pre-release/build suffix
// (0.1.1-beta.1, 0.1.1+build.5). No leading "v" — that's added only when
// forming git tags / changelog links below.
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
if (!SEMVER_RE.test(rawVersion)) {
  fail(`"${rawVersion}" doesn't look like a semver version (expected e.g. "0.1.1"). No files were changed.`);
}
const version = rawVersion;

// ---------------------------------------------------------------------------
// 1. package.json files: root, every apps/*, every packages/*.
// ---------------------------------------------------------------------------

function listWorkspaceDirs(groupDir) {
  const abs = join(REPO_ROOT, groupDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((name) => statSync(join(abs, name)).isDirectory())
    .map((name) => join(groupDir, name));
}

const packageJsonPaths = [
  "package.json",
  ...["apps", "packages"].flatMap((group) =>
    listWorkspaceDirs(group)
      .map((dir) => join(dir, "package.json"))
      .filter((p) => existsSync(join(REPO_ROOT, p))),
  ),
];

const updatedFiles = [];

for (const relPath of packageJsonPaths) {
  const abs = join(REPO_ROOT, relPath);
  const text = readFileSync(abs, "utf-8");
  const pkg = JSON.parse(text);
  if (typeof pkg.version !== "string") {
    console.warn(`[metaharn] skipping ${relPath} — no "version" field`);
    continue;
  }
  const before = pkg.version;
  pkg.version = version;
  // Preserve 2-space indentation + trailing newline, matching this repo's
  // existing package.json formatting.
  writeFileSync(abs, JSON.stringify(pkg, null, 2) + "\n");
  updatedFiles.push(`${relPath} (${before} -> ${version})`);
}

// ---------------------------------------------------------------------------
// 2. apps/web/src-tauri/tauri.conf.json's own "version" field.
//    (Cargo.toml's version and the rest of src-tauri's packaging/bundling
//    setup are out of scope here — see docs/RELEASING.md.)
// ---------------------------------------------------------------------------

const tauriConfPath = "apps/web/src-tauri/tauri.conf.json";
const tauriConfAbs = join(REPO_ROOT, tauriConfPath);
if (existsSync(tauriConfAbs)) {
  const text = readFileSync(tauriConfAbs, "utf-8");
  const conf = JSON.parse(text);
  const before = conf.version;
  conf.version = version;
  writeFileSync(tauriConfAbs, JSON.stringify(conf, null, 2) + "\n");
  updatedFiles.push(`${tauriConfPath} (${before} -> ${version})`);
} else {
  console.warn(`[metaharn] skipping ${tauriConfPath} — file not found`);
}

// ---------------------------------------------------------------------------
// 3. CHANGELOG.md: move [Unreleased] content under a new version heading,
//    leave a fresh empty [Unreleased] above it, fix the link footer.
// ---------------------------------------------------------------------------

const changelogPath = "CHANGELOG.md";
const changelogAbs = join(REPO_ROOT, changelogPath);
if (!existsSync(changelogAbs)) {
  fail(`${changelogPath} not found — expected it at the repo root.`);
}

const changelog = readFileSync(changelogAbs, "utf-8");
const lines = changelog.split("\n");

const unreleasedIdx = lines.findIndex((line) => line.trim() === "## [Unreleased]");
if (unreleasedIdx === -1) {
  fail(`couldn't find a "## [Unreleased]" heading in ${changelogPath} — nothing changed.`);
}
let nextHeadingIdx = lines.findIndex((line, i) => i > unreleasedIdx && line.startsWith("## ["));
if (nextHeadingIdx === -1) nextHeadingIdx = lines.length;

const body = lines
  .slice(unreleasedIdx + 1, nextHeadingIdx)
  .join("\n")
  .trim();

if (!body) {
  console.warn(
    `[metaharn] warning: the [Unreleased] section in ${changelogPath} is empty — ` +
      `the new [${version}] section will have no entries. Consider filling in [Unreleased] ` +
      "with what actually changed before running this script.",
  );
}

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

const prefix = lines.slice(0, unreleasedIdx + 1).join("\n"); // through "## [Unreleased]"
const suffix = lines.slice(nextHeadingIdx).join("\n"); // from the next "## [" heading onward

const newSection = `## [${version}] - ${today}` + (body ? `\n\n${body}` : "");

let newChangelog = `${prefix}\n\n${newSection}\n\n${suffix}`;

// Fix the compare-link footer. The [Unreleased] link is always of the form
// "[Unreleased]: <repo>/compare/<prevTag>...HEAD" — read the repo URL and
// previous tag out of it, then point [Unreleased] at the new tag and add a
// link for the new version comparing against the previous one.
const footerRe = /^\[Unreleased\]:\s*(https:\/\/\S+)\/compare\/(\S+)\.\.\.HEAD\s*$/m;
const footerMatch = newChangelog.match(footerRe);
if (!footerMatch) {
  console.warn(
    `[metaharn] warning: couldn't find a "[Unreleased]: .../compare/<tag>...HEAD" link in ` +
      `${changelogPath} — section moved, but the link footer was left untouched. Fix it by hand.`,
  );
} else {
  const [fullMatch, repoUrl, prevTag] = footerMatch;
  const newTag = `v${version}`;
  const newFooterBlock =
    `[Unreleased]: ${repoUrl}/compare/${newTag}...HEAD\n` + `[${version}]: ${repoUrl}/compare/${prevTag}...${newTag}`;
  newChangelog = newChangelog.replace(fullMatch, newFooterBlock);
}

writeFileSync(changelogAbs, newChangelog);
updatedFiles.push(`${changelogPath} (new "## [${version}] - ${today}" section)`);

// ---------------------------------------------------------------------------
// Report + next steps. No git commands run here — on purpose.
// ---------------------------------------------------------------------------

console.log(`[metaharn] bumped to ${version}:\n`);
for (const f of updatedFiles) console.log(`  - ${f}`);

console.log(`\n[metaharn] Nothing was committed, tagged, or pushed. Next steps:\n`);
console.log(`  git diff                                   # review the changes above`);
console.log(`  git add -A`);
console.log(`  git commit -m "Release v${version}"`);
console.log(`  git tag v${version}`);
console.log(`  git push && git push --tags                # pushing the tag triggers .github/workflows/release.yml`);
console.log(
  `\n[metaharn] release.yml builds + publishes arm64/x64 DMGs as a GitHub draft release — a human still ` +
    `reviews and publishes it from the GitHub UI (see docs/RELEASING.md).`,
);
