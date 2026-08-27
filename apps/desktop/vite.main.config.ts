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
      // Real npm dependencies stay external and get physically copied into
      // a packaged build's node_modules by forge.config.ts's afterCopy hook
      // (see scripts/copy-external-deps.js) instead of being bundled here.
      //
      // Tried bundling dotenv directly first (plain JS, no native bindings —
      // looked safe) since that removes the runtime node_modules dependency
      // entirely for packages that support it. It isn't safe: dotenv's own
      // source calls `require("fs")` internally, and Rolldown's CJS-interop
      // shim for that only works if a real `require` exists at runtime —
      // which it doesn't in this file, forced to real ESM output (see the
      // comment above) for @earendil-works/pi-coding-agent's sake. Confirmed
      // by actually launching the packaged app: `Uncaught Exception: Error:
      // Calling require for "fs" in an environment that doesn't expose the
      // require function`, thrown from dotenv's own bundled code. Reverted
      // rather than risk the same failure mode in drizzle-orm/typebox too —
      // copy-external-deps.js's file-copy approach has none of this risk
      // for any of these, so all real dependencies use it uniformly now.
      //
      // node-pty additionally ships a native .node binary that could never have been bundled
      // by Rollup/Rolldown in the first place. better-sqlite3 (@metaharn/engine's memory
      // store) is the same class of dependency for the same reason. @modelcontextprotocol/sdk
      // (@metaharn/engine's MCP client) has no native binary but its stdio transport calls
      // require("child_process") internally — a real, reproduced crash under this forced-ESM
      // bundle (`Calling require for "child_process" in an environment that doesn't expose
      // the require function`), the identical failure mode as dotenv above.
      // Tried a function here first (`id.startsWith("@modelcontextprotocol/sdk")`) to cover
      // every subpath import at once instead of enumerating each one, the way dotenv/config
      // already has to be listed separately from dotenv. That works for a plain `vite build`
      // CLI run but breaks `electron-forge start`'s dev-mode watcher, which goes through
      // Rolldown's native binding instead: `Error: Value is none of these types Array<T>,
      // ThreadsafeFunction, on BindingInputOptions.external` — that binding requires a literal
      // array, so every subpath the MCP client (@metaharn/engine's mcp/client.ts) actually
      // imports is enumerated explicitly instead.
      external: [
        "dotenv",
        "dotenv/config",
        "drizzle-orm",
        "typebox",
        "@earendil-works/pi-coding-agent",
        "node-pty",
        "better-sqlite3",
        "@modelcontextprotocol/sdk",
        "@modelcontextprotocol/sdk/client/index.js",
        "@modelcontextprotocol/sdk/client/stdio.js",
        "@modelcontextprotocol/sdk/client/streamableHttp.js",
        "@modelcontextprotocol/sdk/shared/transport.js",
        "@modelcontextprotocol/sdk/types.js",
      ],
    },
  },
});
