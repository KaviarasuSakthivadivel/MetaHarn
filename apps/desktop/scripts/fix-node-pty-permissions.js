// node-pty ships a `spawn-helper` binary per-platform under its own
// `prebuilds/<platform>/` directory (Unix only — Windows uses conpty
// instead). It needs the executable bit set, which node-pty's own
// `postinstall` script normally does — but that script gets blocked by this
// environment's install-script allowlist, so `spawn-helper` lands
// non-executable and every pty.spawn() call fails with "posix_spawnp
// failed." Fix it directly here instead of depending on that script running.
import { existsSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";

if (process.platform !== "win32") {
  for (const base of [
    join(import.meta.dirname, "../../../node_modules/node-pty/prebuilds"), // hoisted to workspace root
    join(import.meta.dirname, "../node_modules/node-pty/prebuilds"), // local to apps/desktop
  ]) {
    if (!existsSync(base)) continue;
    for (const platformDir of readdirSync(base)) {
      const helper = join(base, platformDir, "spawn-helper");
      if (existsSync(helper)) {
        chmodSync(helper, 0o755);
        console.log(`[metaharn] chmod +x ${helper}`);
      }
    }
  }
}
