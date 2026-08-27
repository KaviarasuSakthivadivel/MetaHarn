import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { PublisherGithub } from "@electron-forge/publisher-github";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { copyExternalDeps } from "./scripts/copy-external-deps.js";

// Windows/Linux makers (Squirrel, deb, rpm) are intentionally not wired up
// yet — the Vite plugin structure below already ships main/preload/renderer
// independent of platform, so adding them later is a config change, not a
// restructure. See docs/PLAN.md.
const config: ForgeConfig = {
  packagerConfig: {
    // Only node-pty needs unpacking — it ships a real native .node binary,
    // which Electron cannot dlopen from inside a read-only asar archive.
    // Everything else copyExternalDeps() places in node_modules (below) is
    // plain JS and asar-safe.
    asar: { unpack: "**/node-pty/**" },
    // Extension auto-completes per platform (.icns here on macOS). Source
    // artwork is assets/icon.svg; assets/icon.iconset/*.png + icon.icns
    // are generated from it (see docs/architecture — regenerate with
    // sharp + `iconutil -c icns` if the artwork changes).
    icon: "./assets/icon",
    // No Apple Developer ID configured on this machine yet — builds are
    // unsigned. Leaving osxSign/osxNotarize absent rather than half-filled
    // with placeholder values; see docs/RELEASING.md for what real signing
    // needs and what an unsigned .dmg means for someone downloading it.
    //
    // afterCopy runs once apps/desktop's own files are staged into the
    // packaged build, before asar packing — the right moment to also copy
    // in the packages vite.main.config.ts deliberately keeps external
    // (node-pty, @earendil-works/pi-coding-agent, and their full dependency
    // trees). Without this, a packaged build has NONE of them: this is an
    // npm workspaces monorepo, apps/desktop's own node_modules is nearly
    // empty (everything real is hoisted to the repo root), and
    // electron-packager only ever looks at the app's own node_modules.
    // Real, reproduced bug this fixes, not a defensive guess — a genuinely
    // installed build failed with `Cannot find package 'dotenv'` on launch
    // before this existed. See scripts/copy-external-deps.js for the actual
    // resolution logic.
    afterCopy: [
      (buildPath, _electronVersion, platform, arch, callback) => {
        try {
          copyExternalDeps(buildPath, platform, arch);
          callback();
        } catch (err) {
          callback(err as Error);
        }
      },
    ],
  },
  // node-pty already ships correct prebuilt native binaries for both
  // darwin-x64 and darwin-arm64 (node_modules/node-pty/prebuilds/), matching
  // Electron's own ABI — no rebuild-from-source needed or wanted. (An earlier
  // version of this comment blamed a silent packaging failure on "sandbox
  // restrictions" — that diagnosis was wrong. The real cause, found by
  // actually reproducing and root-causing it: this dev machine's only
  // installed Node (v26.5.0) was too new for several native addons in the
  // DMG-maker's own dependency chain to build against, unrelated to node-pty
  // or this rebuildConfig at all. See docs/RELEASING.md.)
  //
  // better-sqlite3 (@metaharn/engine's memory store) is the opposite case: its
  // own install script fetches/builds a binary for the SYSTEM Node that ran
  // `npm install`, not Electron's bundled Node/V8 — a real, reproduced ABI
  // mismatch (`new Database(...)` throwing inside the actual Electron main
  // process; the dev-loop fix is scripts/rebuild-native-modules.js's postinstall
  // step, but a PACKAGED build's node_modules is assembled fresh by
  // copyExternalDeps/electron-packager and needs its own rebuild pass here).
  rebuildConfig: { onlyModules: ["better-sqlite3"] },
  makers: [new MakerZIP({}, ["darwin"]), new MakerDMG({}, ["darwin"])],
  publishers: [
    new PublisherGithub({
      repository: { owner: "KaviarasuSakthivadivel", name: "MetaHarn" },
      // Reads GITHUB_TOKEN from the environment itself if authToken isn't
      // set here — works with `gh`'s token locally and secrets.GITHUB_TOKEN
      // in Actions, so no token lives in this file. Draft on purpose: a
      // `make`/`publish` run stages the release for a human to review
      // (description, which assets) before it goes live and notifies
      // watchers, rather than auto-publishing straight to the public feed.
      draft: true,
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main/main.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/preload/preload.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
