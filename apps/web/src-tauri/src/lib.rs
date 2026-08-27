// Deliberately minimal — matching OpenWorker's own src-tauri/src/lib.rs description
// ("a process supervisor with a webview glued on"). This process owns none of MetaHarn's
// actual logic: that all lives in @metaharn/server (plain Node) and this webview's own
// JS/React code (apps/web/src), talking to the server over HTTP + WebSocket with the token
// vite.config.ts bakes into the bundle at build/dev time.
//
// In dev mode, tauri.conf.json's `beforeDevCommand` (npm run dev:full) starts BOTH
// @metaharn/server and the Vite dev server before this window even opens — no custom Rust
// process-spawning code is needed for that path.
//
// NOT built in this pass, and disclosed rather than guessed at: a packaged build has no dev
// server to point at, so a real `tauri build` needs @metaharn/server bundled as an actual
// sidecar binary (Tauri's own sidecar mechanism — see
// https://v2.tauri.app/develop/sidecar/ — typically via `pkg`/`nexe` to produce a real
// executable, since Tauri sidecars are plain binaries, not "run this with node"). That's a
// distinct packaging task from getting `tauri dev` working, and needs its own pass.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the MetaHarn Tauri application");
}
