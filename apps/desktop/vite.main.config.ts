import { defineConfig } from "vite";

// https://vitejs.dev/config
//
// Main-process output is forced to ESM (package.json has "type": "module")
// because @earendil-works/pi-coding-agent is a pure-ESM package with no
// "require" export condition — a CJS main bundle can't require() it at all,
// and even with it marked external, Node's CJS loader would still reject it
// (ERR_PACKAGE_PATH_NOT_EXPORTED). Real ESM `import` resolves it correctly.
export default defineConfig({
  build: {
    lib: {
      entry: "src/main/main.ts",
      fileName: () => "main.js",
      formats: ["es"],
    },
    rollupOptions: {
      // Keep real npm dependencies external and let Node's own module
      // resolution handle them at runtime instead of Rollup bundling them
      // in. @metaharn/context-engine and @metaharn/db are NOT included here —
      // they're uncompiled TypeScript workspace packages (always run via
      // tsx's loader until now), and Node's native ESM loader can't resolve
      // their ".js"-suffixed relative imports against .ts source files the
      // way tsx does. Letting Rollup bundle them directly (it compiles their
      // TS itself) sidesteps that entirely.
      external: [
        "dotenv",
        "dotenv/config",
        "drizzle-orm",
        "typebox",
        "@earendil-works/pi-coding-agent",
        // Native module (ships prebuilt .node binaries) — cannot be bundled.
        "node-pty",
      ],
    },
  },
});
