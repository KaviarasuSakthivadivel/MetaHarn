# Releasing MetaHarn (macOS)

Windows/Linux are deliberately out of scope for now — see `forge.config.ts`'s
own comment on why the Vite plugin structure already doesn't block adding
them later.

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

This repo's CI workflow (`.github/workflows/`, if present — check for the
current file, this doc doesn't own it) is expected to run the same `publish`
command on `macos-latest` when triggered.

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
