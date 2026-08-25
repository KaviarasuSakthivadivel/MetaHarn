// Copies the packages this app's Vite build deliberately keeps external
// (see vite.main.config.ts's rollupOptions.external comment) — plus their
// full production dependency trees — into a packaged build's own
// node_modules.
//
// Why this exists at all: this is an npm workspaces monorepo, and
// electron-packager only ever looks at apps/desktop's own node_modules when
// assembling a packaged app. Almost everything real here is hoisted to the
// repo root instead (confirmed: apps/desktop/node_modules has effectively
// nothing in it) — dev mode never surfaces this because `npm run start`
// runs straight from the monorepo source tree, where Node's own upward
// node_modules search finds the hoisted copies fine. A packaged build has
// no such search path once it's copied out into its own directory, so any
// package left `external` in the Vite config would otherwise be completely
// absent at runtime (this is exactly what broke: `Cannot find package
// 'dotenv'` in a real installed build, on a real error report, not a guess).
//
// Resolution deliberately does NOT use require.resolve/import.meta.resolve
// — @earendil-works/pi-coding-agent and several of its own dependencies are
// pure ESM with no "require" export condition, which require.resolve
// refuses to resolve at all. A manual upward node_modules walk only cares
// about where the package physically lives on disk, which is all this
// needs and sidesteps the ESM/CJS export-condition question entirely.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function resolvePkgDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function collectClosure(rootNames, fromDir) {
  const resolvedDirs = new Map(); // package name -> absolute dir
  const missing = [];

  function walk(name, dir) {
    if (resolvedDirs.has(name)) return;
    const pkgDir = resolvePkgDir(name, dir);
    if (!pkgDir) {
      missing.push(name);
      return;
    }
    resolvedDirs.set(name, pkgDir);
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const deps = { ...(pkgJson.dependencies || {}), ...(pkgJson.optionalDependencies || {}) };
    for (const dep of Object.keys(deps)) walk(dep, pkgDir);
  }

  for (const name of rootNames) walk(name, fromDir);
  return { resolvedDirs, missing };
}

/**
 * @param {string} buildPath - electron-packager's staged app directory
 *   (apps/desktop's files already copied here, before asar packing).
 */
export function copyExternalDeps(buildPath) {
  // Keep this in sync with vite.main.config.ts's rollupOptions.external —
  // every real npm dependency the main-process build doesn't bundle needs
  // to physically exist here instead, or it's simply absent at runtime in
  // a packaged build (see that file's comment for why bundling dotenv
  // directly was tried and reverted; drizzle-orm/typebox were never tried
  // since the same CJS/ESM interop risk applies to any real npm package).
  const EXTERNAL_ROOTS = ["dotenv", "drizzle-orm", "typebox", "node-pty", "@earendil-works/pi-coding-agent"];
  const { resolvedDirs, missing } = collectClosure(EXTERNAL_ROOTS, REPO_ROOT);

  // Optional platform-specific native-binary packages (e.g.
  // @mariozechner/clipboard-<platform>) legitimately don't exist for
  // platforms other than the one this was `npm install`ed on — npm only
  // installs the matching optional variant. Anything else missing is a
  // real problem worth failing loudly on, not silently shipping a broken
  // build.
  const realMissing = missing.filter((name) => !/-(darwin|linux|win32)-/.test(name));
  if (realMissing.length > 0) {
    throw new Error(`copy-external-deps: could not resolve required package(s): ${realMissing.join(", ")}`);
  }

  const destNodeModules = path.join(buildPath, "node_modules");
  let copied = 0;
  for (const [name, srcDir] of resolvedDirs) {
    const destDir = path.join(destNodeModules, name);
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.cpSync(srcDir, destDir, { recursive: true, dereference: true });
    copied++;
  }
  console.log(`[copy-external-deps] copied ${copied} package(s) into ${destNodeModules}`);
}
