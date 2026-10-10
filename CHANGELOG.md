# Changelog

All notable changes to MetaHarn are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/) in intent, though pre-1.0 minor bumps may
still include breaking changes.

## [Unreleased]

## [0.1.2] - 2026-10-10

## [0.1.1] - 2026-10-10

### Added
- Chat messages render as real Markdown — headings, tables, and bold text no
  longer show up as literal `##`/`|...|`/`**` characters, and fenced code
  blocks get syntax highlighting plus a Copy button.
- A CI workflow (`.github/workflows/ci.yml`) typechecks every workspace and
  builds the web app on every push and pull request to `main`, so a change's
  releasability is known before any release is cut.
- Releases are now cut automatically (`.github/workflows/auto-release.yml`):
  every push to `main` bumps the patch version, updates this changelog,
  tags, and triggers the existing build/publish pipeline — a human still
  reviews and publishes the resulting draft release. `npm run
  release:version` remains available for a deliberate minor/major bump.

### Changed
- The Workspace sidebar now defaults to 25% of the window width instead of a
  fixed 220px.

### Fixed
- The Project Overview page's Idle status filter showed "No sessions match
  this filter" even though every session card displayed an "Idle" badge —
  the badge was a misleading placeholder shown for sessions with no tracked
  live status at all, not the real idle state the filter checked for. It no
  longer claims a status it doesn't have.
- `apps/desktop` imported `@earendil-works/pi-agent-core` without declaring
  it as a direct dependency, relying on npm's hoisting to expose it as a
  side effect of `@earendil-works/pi-coding-agent`'s own dependency tree —
  fragile, and now declared explicitly.

### Security
- Fixed `fast-uri`, `hono`, `ip-address`, `proxy-addr` (critical IP spoofing
  via IPv4-mapped IPv6 trust subnet), `qs`, and `brace-expansion` advisories
  via `npm audit fix` (56 → 42 vulnerabilities across the workspace, all
  non-breaking).

## [0.1.0] - 2026-08-25

First real, distributable release.

### Added
- macOS desktop app (Electron, Apple Silicon + Intel) embedding real coding-agent
  CLIs — Claude Code, Codex, Gemini, OpenCode — via `node-pty`, plus a Pi-SDK
  chat mode, in a Workspace-style UI.
- Git panel with Changes/Branches/Log tabs, a real commit graph, and worktree
  management (`git worktree` create/checkout/remove).
- Terminal grid view for watching multiple sessions side by side.
- 18 built-in themes (light and dark), drag-to-reorder session cards.
- Project and session archiving (reversible) and permanent deletion, both
  with confirmation.
- macOS `.dmg` packaging and a GitHub Actions release pipeline
  (`.github/workflows/release.yml`) — tag-triggered, builds and publishes
  arm64 and x64 assets as a draft release for review before going live.

### Fixed
- The first packaged build crashed immediately on launch (`Cannot find
  package 'dotenv'`) — an npm workspaces monorepo hoisting gap where
  Electron Forge only ever looks at `apps/desktop`'s own (nearly empty)
  `node_modules`. Real dependencies now get physically copied into the
  packaged build by a dedicated packaging hook.
- The packaged app was shipping `node-pty`'s native binaries for every
  platform it supports (including Windows, which isn't even wired up yet)
  inside every build — trimmed to just the target platform, ~48MB off the
  installed app size.
- "+ New terminal session"'s agent picker only ever showed already-installed
  CLIs, and was hidden entirely on a single-agent machine — now always
  reachable and lists every known agent, with an Install link for ones not
  yet on `PATH`.

[Unreleased]: https://github.com/KaviarasuSakthivadivel/MetaHarn/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/KaviarasuSakthivadivel/MetaHarn/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/KaviarasuSakthivadivel/MetaHarn/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/KaviarasuSakthivadivel/MetaHarn/releases/tag/v0.1.0
