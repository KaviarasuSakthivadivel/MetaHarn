import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// @metaharn/server writes a fresh random token to this file on every launch (and, under
// `tsx watch`, on every restart) — see apps/server/src/index.ts.
// Must match apps/server/src/index.ts's default exactly — see that file's comment on why it's
// deliberately not 8765 (OpenWorker's own default, which collides when both run at once).
const PORT = Number(process.env.METAHARN_SERVER_PORT ?? 8791);
const stateDir =
  process.env.METAHARN_STATE_DIR ??
  (process.platform === "win32" ? join(process.env.APPDATA ?? "", "MetaHarn") : join(homedir(), ".metaharn"));

function readToken(): string {
  try {
    return readFileSync(join(stateDir, `server-${PORT}.token`), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Serves the current token fresh on every request, instead of baking it into the bundle via
 * `define` at config-evaluation time. That approach (this file's own first version) has a real
 * race: `dev:full` starts @metaharn/server and this Vite dev server CONCURRENTLY, and if Vite
 * finishes evaluating its config before the server has written its token file, the bundle bakes
 * in "" forever — every request then 401s with no way to recover short of restarting Vite
 * itself. Hit exactly this running it live: "unauthorized" as soon as the page loaded.
 *
 * OpenWorker's own documented dev workflow sidesteps the race by starting its server and its
 * UI in two SEPARATE terminals, sequentially ("1. Start the local agent server... 2. In a
 * second terminal, start the UI") — not via one concurrent command the way dev:full does here.
 * Serving the token live removes the need to rely on strict ordering at all: the client
 * (client.ts) fetches this endpoint once at startup and retries with backoff if the server
 * hasn't written its token yet, so dev:full's concurrency is safe regardless of which process
 * happens to finish starting first — and it keeps working across a `tsx watch` restart, which
 * rotates the token and would otherwise strand an already-loaded page with a dead one.
 *
 * Dev-mode only: a packaged Tauri build serves the built static bundle with no Vite dev server
 * behind it, so this middleware doesn't exist there — see apps/web/src-tauri's own disclosed
 * gap on how a packaged build needs to receive its token instead (in-memory from Tauri's Rust
 * side, matching OpenWorker's packaged-app convention of never writing it to disk at all).
 */
function tokenEndpoint(): Plugin {
  return {
    name: "metaharn-token-endpoint",
    configureServer(server) {
      server.middlewares.use("/__metaharn-config", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.end(
          JSON.stringify({
            token: readToken(),
            serverUrl: `http://localhost:${PORT}`,
            wsUrl: `ws://localhost:${PORT}`,
          }),
        );
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tokenEndpoint()],
  server: { port: 5175 },
});
