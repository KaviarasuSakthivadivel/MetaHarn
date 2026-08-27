// better-sqlite3 (pulled in transitively by @metaharn/engine's memory store) ships its own
// install script (`prebuild-install || node-gyp rebuild --release`), which — like node-pty's
// postinstall (see fix-node-pty-permissions.js) — gets blocked by this environment's
// install-script allowlist. Even when it DOES run, `prebuild-install` fetches/builds a binary
// matching the SYSTEM Node that ran `npm install`, not Electron's own bundled Node/V8 — a real,
// reproduced ABI mismatch (`new Database(path)` throwing inside the actual Electron main
// process, while the identical call works fine under plain system Node). forge.config.ts's
// `rebuildConfig.onlyModules: []` deliberately skips Forge's own packaging-time rebuild step
// for every native module BECAUSE node-pty ships correct prebuilt binaries already and needs
// no rebuild — that reasoning has never applied to better-sqlite3, which has no such prebuild
// for Electron's ABI. This covers the dev-loop case (electron-forge start reads straight from
// node_modules, no packaging step involved); forge.config.ts's own rebuildConfig covers the
// packaged-build case separately.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const rebuildBin = join(REPO_ROOT, "node_modules", ".bin", "electron-rebuild");
const electronPkg = join(REPO_ROOT, "node_modules", "electron", "package.json");

if (!existsSync(rebuildBin) || !existsSync(electronPkg)) {
  console.warn("[metaharn] electron-rebuild or electron not found yet — skipping better-sqlite3 rebuild " +
    "(run `npx electron-rebuild -f -w better-sqlite3` manually once both are installed)");
  process.exit(0);
}

const electronVersion = JSON.parse(readFileSync(electronPkg, "utf-8")).version;
console.log(`[metaharn] rebuilding better-sqlite3 for Electron ${electronVersion}...`);
try {
  execFileSync(rebuildBin, ["-f", "-w", "better-sqlite3", "-v", electronVersion], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
} catch (err) {
  console.warn(
    "[metaharn] better-sqlite3 rebuild failed — memory features will not work until this is fixed " +
      "manually (npx electron-rebuild -f -w better-sqlite3):",
    err.message,
  );
}
