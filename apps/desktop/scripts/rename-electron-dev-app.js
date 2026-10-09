// Dev mode (`electron-forge start`) runs the raw node_modules/electron/dist/Electron.app
// bundle directly — there's no packaged build's own Info.plist to supply "MetaHarn" as the app
// name, so macOS reads the prebuilt Electron.app's OWN Info.plist instead and shows "Electron"
// in the Dock tooltip, Cmd-Tab switcher, and (most visibly) the bold app name at the left of the
// menu bar. This is NOT fixable from the renderer or main process at runtime — app.setName()
// (main.ts) only changes app.getName()'s return value and a few internal paths; the actual
// macOS-level Dock/menu-bar identity is resolved from the bundle's CFBundleName/
// CFBundleDisplayName before Electron's own JS ever runs, confirmed by inspecting the real
// Info.plist (CFBundleName was literally "Electron"). Patching those two keys directly in the
// installed bundle is the standard fix every Electron project hits this same way. Runs every
// `npm install` (chained into postinstall, same as fix-node-pty-permissions.js/
// rebuild-native-modules.js) since node_modules/electron is reinstalled from scratch whenever
// the Electron version changes or node_modules gets wiped — this would silently revert to
// "Electron" again otherwise.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

if (process.platform !== "darwin") {
  process.exit(0); // CFBundleName/Dock/menu-bar naming is a macOS-only concept
}

const APP_NAME = "MetaHarn";
const PLIST_BUDDY = "/usr/libexec/PlistBuddy";

for (const base of [
  join(import.meta.dirname, "../../../node_modules/electron/dist"), // hoisted to workspace root
  join(import.meta.dirname, "../node_modules/electron/dist"), // local to apps/desktop
]) {
  const appPath = join(base, "Electron.app");
  if (!existsSync(appPath)) continue;
  const plistPath = join(appPath, "Contents/Info.plist");

  try {
    execFileSync(PLIST_BUDDY, ["-c", `Set :CFBundleName ${APP_NAME}`, plistPath]);
    try {
      execFileSync(PLIST_BUDDY, ["-c", `Add :CFBundleDisplayName string ${APP_NAME}`, plistPath]);
    } catch {
      // Key already exists on a re-run (postinstall runs on every install, not just the first) —
      // Add fails in that case, Set is the right call instead.
      execFileSync(PLIST_BUDDY, ["-c", `Set :CFBundleDisplayName ${APP_NAME}`, plistPath]);
    }
    // Clears any stale cached "Electron" entry so the Dock/menu bar picks up the rename on the
    // very next launch, not just after some unrelated Launch Services refresh.
    execFileSync(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", appPath],
    );
    console.log(`[metaharn] renamed dev Electron.app bundle to "${APP_NAME}" (${appPath})`);
  } catch (err) {
    console.warn(`[metaharn] couldn't rename dev Electron.app bundle (non-fatal — it'll just show "Electron" in the Dock/menu bar):`, err.message);
  }
}
