# Icons needed before the first `tauri build` (not required for `tauri dev`)

This directory is intentionally empty. `tauri.conf.json`'s `bundle.icon` list expects real
files here (`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico`) that only
the Tauri CLI can generate correctly (per-platform sizes, real `.icns`/`.ico` containers) —
hand-crafting them would just produce corrupt image files.

Once the Rust toolchain is installed (`rustup`, per the root README's prerequisites), generate
them from the same source artwork the Electron app already uses:

```bash
cd apps/web
npx tauri icon ../desktop/assets/icon.png
```

`tauri dev` does not need these — only `tauri build`/`tauri bundle` does.
