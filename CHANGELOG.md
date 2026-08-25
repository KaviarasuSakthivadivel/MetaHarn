# Changelog

All notable changes to MetaHarn are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/) in intent, though pre-1.0 minor bumps may
still include breaking changes.

## [Unreleased]

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

[Unreleased]: https://github.com/KaviarasuSakthivadivel/MetaHarn/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/KaviarasuSakthivadivel/MetaHarn/releases/tag/v0.1.0
