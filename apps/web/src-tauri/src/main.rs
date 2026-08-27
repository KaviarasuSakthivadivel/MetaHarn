// Prevents an extra console window from popping up on Windows in release builds — standard
// boilerplate the `tauri-cli` v2 scaffold generates verbatim, kept as-is.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    metaharn_web_lib::run();
}
