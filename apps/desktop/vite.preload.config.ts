import { defineConfig } from "vite";

// https://vitejs.dev/config
//
// Explicit .cjs extension: package.json now has "type": "module" for the
// main process's sake, and a plain .js preload output would otherwise be
// misread as ESM even though it's built as CJS (preload has no ESM-specific
// need here, unlike main).
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        entryFileNames: "[name].cjs",
        chunkFileNames: "[name].cjs",
      },
    },
  },
});
