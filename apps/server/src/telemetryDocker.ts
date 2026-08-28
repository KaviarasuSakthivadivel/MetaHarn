/**
 * Auto-starts the self-hosted Laminar stack (the `lmnr-*` services under the "telemetry"
 * profile in the repo root's docker-compose.yml) whenever telemetry is enabled and pointed at
 * a local endpoint — so enabling telemetry once is enough; nobody has to remember to run
 * `docker compose --profile telemetry up -d` before every `npm run dev:server`.
 *
 * Deliberately targets the five `lmnr-*` services by name rather than the whole `--profile
 * telemetry` set: that set also implicitly includes this compose file's own `postgres` service
 * (no `profiles:` key on it means "always on"), and that service binding host port 5432 is
 * unrelated to telemetry and shouldn't fail (or spam a warning) just because telemetry is what
 * triggered a `docker compose up`.
 *
 * Fully tolerant of Docker not being installed or not running — this is best-effort convenience,
 * never a hard dependency: a warning gets logged and the app keeps working exactly as it did
 * before this existed (telemetry calls simply fail to reach a collector, same as if the user
 * forgot to start it manually).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TELEMETRY_SERVICES = ["lmnr-postgres", "lmnr-clickhouse", "lmnr-quickwit", "lmnr-frontend", "lmnr-app-server"];

const SELF_HOSTED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** True for "http://localhost", "http://127.0.0.1", etc. — false for Laminar Cloud
 * (api.lmnr.ai) or any other remote host, where this repo's own docker-compose.yml has nothing
 * to do with reaching the configured endpoint. */
export function isSelfHostedEndpoint(baseUrl: string): boolean {
  try {
    return SELF_HOSTED_HOSTNAMES.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

let startInFlight = false;

/** Fire-and-forget — callers don't await this. Safe to call on every server boot and every
 * telemetry-enable request; a stack that's already up just no-ops (`docker compose up -d` is
 * idempotent), and a second call while one is already running is skipped outright. */
export function ensureTelemetryStackRunning(): void {
  if (startInFlight) return;
  if (!existsSync(join(REPO_ROOT, "docker-compose.yml"))) return;
  startInFlight = true;
  const child = spawn(
    "docker",
    ["compose", "--profile", "telemetry", "up", "-d", ...TELEMETRY_SERVICES],
    { cwd: REPO_ROOT, stdio: "ignore", detached: true },
  );
  child.on("error", (err) => {
    startInFlight = false;
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? "Docker isn't installed or not on PATH" : err.message;
    console.warn(
      `[metaharn-server] couldn't auto-start the telemetry stack (${reason}) — start it yourself with ` +
        `'docker compose --profile telemetry up -d', or traces just won't reach a collector until you do.`,
    );
  });
  child.on("exit", (code) => {
    startInFlight = false;
    if (code === 0) console.log("[metaharn-server] telemetry stack is up (docker compose --profile telemetry)");
    else console.warn(`[metaharn-server] 'docker compose --profile telemetry up -d' exited with code ${code}`);
  });
  child.unref();
}
