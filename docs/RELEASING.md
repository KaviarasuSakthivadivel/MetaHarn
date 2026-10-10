# Releasing MetaHarn (macOS)

Windows/Linux are deliberately out of scope for now — see `forge.config.ts`'s
own comment on why the Vite plugin structure already doesn't block adding
them later.

## Continuous Integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request targeting `main`, on `ubuntu-latest`. It is deliberately separate
from the release pipeline (below) and does **not** build or package the
Electron app — no DMG, no `electron-forge`, nothing macOS-specific — because
nothing it checks needs that. It validates, per workspace:

- `apps/web`: `npm run build --workspace=apps/web` (its own `build` script —
  `tsc --noEmit && vite build`). No native deps, builds cleanly on Linux.
- `apps/desktop` and `apps/server`: `npx tsc --noEmit -p <workspace>/tsconfig.json`.
  Neither has its own typecheck script, so this invokes `tsc` directly against
  each workspace's `tsconfig.json`. Type-checking does not execute the code,
  so this does **not** need `better-sqlite3`/`node-pty`'s native bindings to
  actually load — confirmed by running it on a plain `ubuntu` environment
  with no native rebuild step, before relying on that assumption here.
- `packages/context-engine`, `packages/db`, `packages/engine`: same
  `tsc --noEmit -p <package>/tsconfig.json` treatment — none defines its own
  build/typecheck script either.

There is no automated test suite in this repo yet (no vitest/jest/`node:test`
config anywhere), so CI doesn't run one — this is a real gap, not an
oversight, and should be closed by adding real tests and a test step
together, rather than wiring up an empty placeholder step now.

A green CI run on `main` is the bar for "releasable" — it's what the release
flow below assumes you check before tagging.

## Cutting a release

Releasing is a deliberate, separate action from ordinary development — it
never happens automatically off of CI going green on `main`. The flow:

1. **Make sure `main` is green** (the CI workflow above) and that
   `CHANGELOG.md`'s `[Unreleased]` section actually describes what shipped
   since the last release. Fill it in by hand first if it's empty — the
   version-bump script below moves whatever is already there, it doesn't
   write changelog entries for you.
2. **Run the version-bump helper** from the repo root:
   ```
   npm run release:version -- <X.Y.Z>
   ```
   (`scripts/bump-version.mjs`.) This writes `<X.Y.Z>` into every workspace's
   `package.json` (root, every `apps/*`, every `packages/*`) plus
   `apps/web/src-tauri/tauri.conf.json`'s own `version` field, and rewrites
   `CHANGELOG.md`: the `[Unreleased]` section's content moves under a new
   `## [X.Y.Z] - <today>` heading, a fresh empty `[Unreleased]` section is
   left above it, and the compare-link footer at the bottom is fixed up
   (`[Unreleased]` now compares `vX.Y.Z...HEAD`, and a new `[X.Y.Z]` link
   compares against the previous tag). It only edits files — no git commands
   run as part of it.
3. **Review the diff** (`git diff`) like any other change before committing.
4. **Commit, tag, and push** — deliberately manual, not scripted:
   ```
   git add -A
   git commit -m "Release vX.Y.Z"
   git tag vX.Y.Z
   git push && git push --tags
   ```
5. **Pushing the tag triggers `.github/workflows/release.yml`** on
   `macos-latest`: it runs `electron-forge publish` twice (`--arch=arm64`,
   then `--arch=x64` — see the universal-build note below for why not one
   combined run) and uploads both DMGs/zips to a **draft** GitHub Release via
   `PublisherGithub` (`draft: true` in `forge.config.ts`).
6. **A human reviews and publishes the draft release manually** from the
   GitHub UI (unchanged from before this doc existed) — check the attached
   arm64 and x64 assets are both present, edit the release notes/description
   as desired (the changelog entry from step 2 is a good starting point),
   then hit **Publish**.

`workflow_dispatch` is also wired up on `release.yml` if you ever need to
re-run the build/publish step for an existing tag without re-pushing it.

**Outstanding draft from the last release**: `v0.1.0`'s GitHub Release has
been sitting as an unpublished **Draft** since it was created (2026-08-25) —
it was never actually made public, and roughly 10 commits of real,
shipped-looking work (terminal grid rework, usage/cost tracking, sidebar and
settings redesign, the near-black/amber retheme, memory tiers, and more)
have landed on `main` since, undocumented in `CHANGELOG.md` until now.
Whoever cuts the next release should explicitly decide what to do with that
stale `v0.1.0` draft — publish it as-is first (if `v0.1.0` really is a
meaningful, independently-releasable point), delete it, or just let the next
tag (`v0.1.1` or later) supersede it — rather than letting it linger
unaddressed.

## Building a `.dmg` locally

```
npm run make --workspace=apps/desktop
```

Electron Forge (`apps/desktop/forge.config.ts`) runs both `MakerZIP` and
`MakerDMG` for `darwin`, producing `apps/desktop/out/make/*.dmg` and a
matching `.zip`. `MakerDMG`'s config is left at its defaults (`{}`) — no
custom background/icon layout configured yet.

**A real, shipped-then-caught packaging bug worth knowing about**: this is
an npm workspaces monorepo, and `apps/desktop`'s own `node_modules` is
nearly empty — everything real is hoisted to the repo root instead.
electron-packager only ever looks at the app's own `node_modules` when
assembling a build, so any real npm dependency the Vite main-process build
doesn't bundle (see `vite.main.config.ts`'s `rollupOptions.external` —
`dotenv`, `drizzle-orm`, `typebox`, `node-pty`,
`@earendil-works/pi-coding-agent`) was completely absent from the first
`.dmg` built this way: a genuinely installed copy crashed on launch with
`Cannot find package 'dotenv'`. Bundling `dotenv` directly instead of
externalizing it was tried next and also failed differently — its own
source calls `require("fs")` internally, which throws at runtime in this
project's forced-ESM main-process output (`Calling require for "fs" in an
environment that doesn't expose the require function`, from a real crash on
a real launch, not a guess). `apps/desktop/scripts/copy-external-deps.js`
is the actual fix: a `forge.config.ts` `afterCopy` hook that resolves the
full production dependency closure of every externalized package (manual
`node_modules` walk, not `require.resolve` — `pi-coding-agent` and several
of its own dependencies are pure ESM with no `require` export condition)
and copies it into the packaged build directly. `node-pty` additionally
needs `packagerConfig.asar.unpack` (already configured) since its native
`.node` binary can't be loaded from inside a read-only asar archive.
Verified by actually launching the packaged binary directly
(`out/MetaHarn-darwin-*/MetaHarn.app/Contents/MacOS/MetaHarn` from a
terminal, not just double-clicking) and confirming `renderer
did-finish-load` with a real Electron process family (main + GPU + renderer
+ network helpers) and no crash, not just that the `.dmg` mounts.

**Universal (arm64+x64) builds don't work for this app — confirmed, not
just untried**: `npx electron-forge make --arch=universal` packages both
architectures successfully, then fails at the final stitching step
(`@electron/universal`) with `While trying to merge mach-o files across
your apps we found a mismatch, the number of mach-o files is not the same
between the arm64 and x64 builds` — the two arch-specific `.app` bundles
have a different number of Mach-O binaries/frameworks inside them (visible
in the `uniqueToArm64`/`uniqueToX64` diff Forge prints right before
failing), most likely from an asymmetry in a native dependency's per-arch
layout (`node-pty` and/or the DMG-maker chain's native addons — not
investigated further since the fallback is simple and standard). **Build
and ship two separate `.dmg`s instead**: `--arch=arm64` and `--arch=x64`,
both verified working (see below) — this is normal practice for Electron
apps with native dependencies, not a workaround for something broken.

**A real, now-fixed local-environment gotcha, not a code defect and not a
sandbox restriction** (an earlier pass through this doc misdiagnosed it as
one — corrected here after actually reproducing and root-causing it): this
machine's only installed Node was v26.5.0, a version newer than the native
modules `@electron-forge/maker-dmg` depends on (`appdmg` → `macos-alias`,
`fs-xattr`, transitively) had been built against. Under Node 26, their
`node-gyp`-compiled `.node` addons either never built successfully during
`npm install` or silently produced nothing usable — the zip-extraction step
electron-packager runs early in packaging (copying/extracting the
Electron.app template) failed the same way, writing only a few hundred KB
of a 100+MB archive before returning success with no error. Switching to
Node 22 LTS (`brew install node@22`, used via `PATH="/opt/homebrew/opt/node@22/bin:$PATH"`
— installed keg-only, doesn't touch the system default `node`), then
`npm rebuild` at the repo root (rebuilds every native addon against the
new ABI, `node-pty` included), fixed packaging outright and surfaced the
`macos-alias`/`fs-xattr` native-module errors clearly instead of silently.
**Confirmed working end to end**: `npm run make --workspace=apps/desktop`
under Node 22 produced a real, verified `.dmg`
(`apps/desktop/out/make/MetaHarn-0.0.1-arm64.dmg`, 117MB) — mounted with
`hdiutil attach`, contains the expected `MetaHarn.app` + `Applications`
symlink drag-install layout, and the app bundle is ad-hoc signed
(`codesign -dv` shows `flags=0x2(adhoc)`, `TeamIdentifier=not set` — expected
for an unsigned build, see the signing section below). If this machine's
Node is ever upgraded again, re-run `npm rebuild` before packaging — that's
the actual fix, not a one-time workaround.

## Publishing a GitHub Release

In the normal flow (see "Cutting a release" above) this step runs
automatically: pushing a `vX.Y.Z` tag triggers `.github/workflows/release.yml`
on `macos-latest`, which runs the same two commands below itself. The manual
version here is for running it from a local machine instead — debugging the
publish step itself, or re-publishing without going through git tags/CI:

```
GITHUB_TOKEN=<token with repo scope> npx electron-forge publish --arch=arm64
GITHUB_TOKEN=<token with repo scope> npx electron-forge publish --arch=x64
```
(two separate runs — universal doesn't work, see above), run from
`apps/desktop`. `PublisherGithub` in `forge.config.ts` targets
`KaviarasuSakthivadivel/MetaHarn` and reads `GITHUB_TOKEN` from the
environment automatically (nothing hardcoded in the repo) — locally, `gh
auth token` or any token with `repo` scope works; in GitHub Actions,
`secrets.GITHUB_TOKEN` is sufficient since it's the same repo.

**Releases publish as drafts** (`draft: true`) on purpose — a human reviews
the staged release (description, which `.dmg`/`.zip` assets attached) and
publishes it manually from the GitHub UI, rather than every `publish` run
immediately going live and notifying watchers.

`.github/workflows/release.yml` runs these same two `publish` commands on
`macos-latest`, triggered by pushing a `vX.Y.Z` tag (or manually via
`workflow_dispatch`) — see "Cutting a release" above for the end-to-end flow.
This is separate from `.github/workflows/ci.yml`, which validates ordinary
pushes/PRs and never builds or publishes anything.

## Code signing / notarization (not yet configured)

No Apple Developer ID certificate exists in the environment this was built
in (`security find-identity -v -p codesigning` returns zero valid
identities), so **every `.dmg` built today is unsigned**. `forge.config.ts`
deliberately leaves `packagerConfig.osxSign`/`osxNotarize` absent rather
than half-configured with placeholder values — add them once real signing
credentials exist.

**What this means for someone who downloads the `.dmg`**: macOS quarantines
anything downloaded from the internet (sets the `com.apple.quarantine`
extended attribute); Gatekeeper then checks for a valid signature on first
launch, and an unsigned app fails that check — the OS reports it as
"damaged" or from an "unidentified developer" rather than clearly saying
"unsigned," which reads scarier than it is. **Workaround for now**:
- Right-click (or Control-click) `MetaHarn.app` in Finder → **Open** → confirm in the dialog that appears (this is a one-time-per-install exception, distinct from a plain double-click), or
- `xattr -cr /Applications/MetaHarn.app` after installing, to strip the quarantine attribute directly.

**What real signing needs later**: an active Apple Developer ID
("Developer ID Application" certificate, ~$99/year Apple Developer Program
membership), then wiring `packagerConfig.osxSign` (signing identity) and
`packagerConfig.osxNotarize` (an app-specific password or API key for
Apple's notarization service) into `forge.config.ts` — both documented in
Electron Forge's own signing guide. Once configured, `make`/`publish` sign
and notarize automatically as part of the same commands above; no other
workflow change needed.
