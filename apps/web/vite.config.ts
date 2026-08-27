import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Reads @metaharn/server's per-launch token file the same way OpenWorker's own Vite config
// reads its sidecar's token ("Vite reads that user-only file when it starts" — this repo's
// README quotes the identical convention). This runs in Vite's own Node process at dev-server
// start, never in the browser, so a plain readFileSync is fine — the browser bundle only ever
// sees the resolved string value baked in by `define` below, not the file path.
const PORT = Number(process.env.METAHARN_SERVER_PORT ?? 8765);
const stateDir =
  process.env.METAHARN_STATE_DIR ??
  (process.platform === "win32" ? join(process.env.APPDATA ?? "", "MetaHarn") : join(homedir(), ".metaharn"));

function readToken(): string {
  try {
    return readFileSync(join(stateDir, `server-${PORT}.token`), "utf8").trim();
  } catch {
    // The server hasn't started yet (or hasn't run since this dev server booted) — the app
    // itself surfaces a clear "can't reach the server" error rather than silently sending an
    // empty token and getting a confusing 401.
    return "";
  }
}

export default defineConfig({
  plugins: [react()],
  server: { port: 5175 },
  define: {
    __METAHARN_SERVER_URL__: JSON.stringify(`http://localhost:${PORT}`),
    __METAHARN_WS_URL__: JSON.stringify(`ws://localhost:${PORT}`),
    __METAHARN_TOKEN__: JSON.stringify(readToken()),
  },
});
