import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { PublisherGithub } from "@electron-forge/publisher-github";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

// Windows/Linux makers (Squirrel, deb, rpm) are intentionally not wired up
// yet — the Vite plugin structure below already ships main/preload/renderer
// independent of platform, so adding them later is a config change, not a
// restructure. See docs/PLAN.md.
const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Extension auto-completes per platform (.icns here on macOS). Source
    // artwork is assets/icon.svg; assets/icon.iconset/*.png + icon.icns
    // are generated from it (see docs/architecture — regenerate with
    // sharp + `iconutil -c icns` if the artwork changes).
    icon: "./assets/icon",
    // No Apple Developer ID configured on this machine yet — builds are
    // unsigned. Leaving osxSign/osxNotarize absent rather than half-filled
    // with placeholder values; see docs/RELEASING.md for what real signing
    // needs and what an unsigned .dmg means for someone downloading it.
  },
  // node-pty already ships correct prebuilt native binaries for both
  // darwin-x64 and darwin-arm64 (node_modules/node-pty/prebuilds/) — no
  // rebuild-from-source is needed or wanted. Forge's default native-module
  // rebuild step (via @electron/rebuild, which shells out to a compiler)
  // gets killed outright by this dev sandbox's install-script/build
  // restrictions (same restriction node-pty's own postinstall already runs
  // into — see scripts/fix-node-pty-permissions.js): `packagerConfig`'s
  // "Preparing native dependencies" step exited the whole process silently
  // within under a second, before even a single architecture finished
  // packaging, confirmed with both a plain arm64 build and a universal
  // build — not something specific to the universal path. `onlyModules: []`
  // tells @electron/rebuild to rebuild nothing, which is correct here since
  // there's nothing that needs rebuilding.
  rebuildConfig: { onlyModules: [] },
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
