// Import once, before creating any editor. Vite's native `?worker` imports
// are Monaco's own current documented bundler integration — no separate
// Vite plugin, no CDN fetch, works fully offline. See docs/PLAN.md.
// monaco-editor's package.json "exports" map ("./*.js": "./esm/vs/*.js")
// prepends esm/vs/ automatically — importing the literal filesystem path
// double-prepends it and fails to resolve at all.
//
// Only the generic editor worker is wired up — the dedicated json/typescript
// language-service workers implement their own protocol (diagnostics,
// completions) but don't also implement the base editor protocol
// (findDocumentLinks/getFoldingRanges/findDocumentSymbols), which throws
// "Missing requestHandler" once Monaco's core editor calls those against
// whatever worker a label maps to. The Files tab is for browsing/light
// edits, not full IntelliSense, so it's not worth chasing that down —
// syntax highlighting works fine without a worker at all (it's synchronous
// Monarch tokenization), only deep language services need one.
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";

self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};
