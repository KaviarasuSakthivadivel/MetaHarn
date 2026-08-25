import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
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
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ["darwin"])],
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
