/**
 * Local PDF handling for models without native PDF support. Ported from OpenWorker's
 * coworker/pdf_support.py.
 *
 * The canonical history always stores a PDF attachment as a `file` content part
 * (attachments.ts's `buildUserContent`). At send time, whichever workstream owns per-model
 * content adaptation checks the ACTIVE model's capabilities (`ModelCapabilities.pdf`,
 * types.ts) and, when the model can't take PDFs natively, calls `adaptContent` to replace the
 * `file` part right before the provider call — the stored history is never mutated, so
 * switching to a PDF-capable model mid-session sends the real document again.
 *
 * Two fallback modes (a user setting):
 *   - "text"   — extract embedded text locally (`pdf-parse`; pure JS). Implemented below.
 *   - "images" — render each page to a PNG and send as image parts; only useful when the
 *                model has vision, else it degrades to text anyway. NOT implemented here —
 *                see `rasterizeToImages`'s docstring for why.
 *
 * Everything runs locally — the document never goes to any vendor "file extract" endpoint.
 * Results are cached by content hash because the history is replayed on every turn.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { MAX_TEXT_CHARS } from "./attachments.js";
import type { ContentPart, ModelCapabilities } from "./types.js";

// `pdf-parse` ships no type declarations and is CommonJS; a static `import pdfParse from
// "pdf-parse"` would need an ambient module declaration added somewhere outside this file.
// `createRequire` sidesteps that entirely (require() is typed `any`) while still working
// correctly from this ESM ("type": "module", moduleResolution NodeNext) package. We only ever
// use it to *resolve* pdf-parse's path, never to load it in-process — see
// `extractTextViaSubprocess`'s docstring for why.
const require = createRequire(import.meta.url);

/**
 * Absolute path to pdf-parse's CJS entry, resolved once at module load and handed to the child
 * process spawned below so its own `require()` doesn't depend on that process's cwd or module
 * search path (resolution alone is safe in-process — see the docstring below; only actually
 * *running* the bundled parser here is not).
 */
const PDF_PARSE_ENTRY = require.resolve("pdf-parse");

/** Hard ceiling on one extraction subprocess's runtime — a malformed PDF must not hang a turn
 * forever waiting on a child that never exits. */
const SUBPROCESS_TIMEOUT_MS = 30_000;

/**
 * Run `pdf-parse` in a one-shot child `node -e` process instead of in-process.
 *
 * `pdf-parse` bundles a ~2018-era webpack build of pdf.js (v1.10.100). Verified against this
 * package's actual runtime (Node with `"type": "module"`, so every file here loads as ESM):
 * calling it in-process — via `createRequire`, and separately via a native `import` — corrupts
 * its own parse on every attempt (deterministically: "bad XRef entry" or "End of file inside
 * array" depending on the loading path), on documents that parse perfectly every time from a
 * genuine CommonJS entry point. That isn't a corner case here — every real PDF would silently
 * come back unreadable. `node:child_process` is stdlib (no new dependency); spawning the exact
 * same `pdfParse(buffer)` call from a true CJS process (`node -e "..."`) is 100% reliable in
 * the same environment where it's tested here. The child reports its result on fd 3 rather than
 * stdout, so pdf.js's own warning/console noise (which lands on stdout/stderr) can never be
 * mistaken for the JSON payload.
 */
function extractTextViaSubprocess(pdfData: Buffer): Promise<string> {
  const script = `
    const pdfParse = require(${JSON.stringify(PDF_PARSE_ENTRY)});
    const fs = require("fs");
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      pdfParse(Buffer.concat(chunks))
        .then((r) => { fs.writeSync(3, JSON.stringify({ text: r.text || "" })); })
        .catch((e) => { fs.writeSync(3, JSON.stringify({ error: String((e && e.message) || e) })); })
        .then(() => process.exit(0));
    });
  `;
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["pipe", "ignore", "ignore", "pipe"],
    });
    const out: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error("pdf extraction timed out"));
      });
    }, SUBPROCESS_TIMEOUT_MS);

    const resultPipe = child.stdio[3];
    resultPipe?.on("data", (c: Buffer) => out.push(c));
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", () => {
      finish(() => {
        try {
          const parsed = JSON.parse(Buffer.concat(out).toString("utf8")) as {
            text?: string;
            error?: string;
          };
          if (parsed.error) reject(new Error(parsed.error));
          else resolve(parsed.text ?? "");
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    child.stdin!.end(pdfData);
  });
}

/** Per-document text cap — matches attachments.ts's MAX_TEXT_CHARS so an extracted PDF and an
 * inlined text-file attachment can never blow the prompt budget differently. */
export const MAX_EXTRACT_CHARS = MAX_TEXT_CHARS;

/** Hard ceiling on pages `rasterizeToImages` would ever render; the user's page-count
 * threshold gates whether a PDF gets attached at all before rasterization is even reached. */
export const RASTER_MAX_PAGES = 100;

export type FallbackMode = "text" | "images";
const FALLBACK_MODES: readonly FallbackMode[] = ["text", "images"];

// Global user preference — mirrors the Python original's module-level setting, set from
// preferences at startup and again on every settings change. CLI/library use keeps "text".
let fallbackModeValue: FallbackMode = "text";

export function setFallbackMode(mode: unknown): FallbackMode {
  fallbackModeValue = FALLBACK_MODES.includes(mode as FallbackMode) ? (mode as FallbackMode) : "text";
  return fallbackModeValue;
}

export function fallbackMode(): FallbackMode {
  return fallbackModeValue;
}

// `${sha256 of the data URL}:${operation}` -> result promise. Tiny cache: history replays
// every turn, and extracting a 10MB PDF's text is the expensive part. Caching the in-flight
// Promise (not just its resolved value) also dedupes concurrent calls for the same document.
const CACHE_MAX = 8;
const cache = new Map<string, Promise<unknown>>();

function cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit as Promise<T>;
  const value = compute();
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

function digest(fileData: string): string {
  return createHash("sha256").update(fileData, "ascii").digest("hex");
}

const PDF_DATA_URL_PREFIX = "data:application/pdf;base64,";

function pdfBytes(fileData: string): Buffer | null {
  if (typeof fileData !== "string" || !fileData.startsWith(PDF_DATA_URL_PREFIX)) return null;
  try {
    return Buffer.from(fileData.slice(PDF_DATA_URL_PREFIX.length), "base64");
  } catch {
    return null;
  }
}

/**
 * Embedded text of the whole document (capped at `MAX_EXTRACT_CHARS`), or `null` if the data
 * URL isn't a readable PDF. Scanned PDFs legitimately resolve to `""` — `adaptContent` (below)
 * surfaces that distinctly from a hard failure.
 *
 * Unlike the Python original (which walks pypdf's page list and stops early once the char cap
 * is hit), this parses the whole document via `pdf-parse` (in a subprocess — see
 * `extractTextViaSubprocess`) and slices the result afterward: `pdf-parse`'s callback-based
 * page renderer has no clean early-abort hook, and a fragile one isn't worth adding for a cap
 * that only matters on unusually large PDFs.
 */
export function extractText(fileData: string): Promise<string | null> {
  return cached(`${digest(fileData)}:text`, async () => {
    const raw = pdfBytes(fileData);
    if (raw === null) return null;
    try {
      const text = await extractTextViaSubprocess(raw);
      return text.slice(0, MAX_EXTRACT_CHARS);
    } catch {
      return null;
    }
  });
}

/**
 * Render each page of a PDF to a PNG data URL — the "images" fallback mode.
 *
 * NOT IMPLEMENTED. OpenWorker's Python original renders with pypdfium2 (a native PDFium
 * binding) plus a hand-rolled PNG encoder to avoid bundling Pillow. There is no equally simple
 * pure-JS equivalent: `pdf-parse` (like every pure-JS PDF reader, pdf.js underneath) can walk
 * a document's text layer, but turning a page into pixels needs a `<canvas>`-shaped 2D
 * rendering target, which on Node means either `node-canvas` (a native module with its own
 * Cairo/libpng build-and-codesign story) or a native PDFium binding of our own — either is a
 * real dependency decision for whoever owns "images" mode, not something to smuggle in as a
 * side effect of a text-extraction module. Until that dependency is chosen deliberately, this
 * throws rather than shipping a silent mis-render. `adaptContent` (below) already treats the
 * throw as "rasterization unavailable" and falls back to text extraction — exactly like the
 * Python original's `rasterize()` returning `None` on any renderer failure.
 */
export async function rasterizeToImages(
  _fileData: string,
  _maxPages: number = RASTER_MAX_PAGES,
): Promise<string[]> {
  throw new Error(
    'rasterizeToImages() is not implemented: pure-JS PDF rasterization needs a native PDFium ' +
      'binding (or node-canvas) this package does not depend on. Use fallback mode "text" ' +
      '(the default) until that dependency is added deliberately for "images" mode.',
  );
}

/**
 * Replace `file` parts for a model without native PDF support. "images" mode + vision -> tries
 * page-image parts first; text mode (or any rasterization failure) -> extracted text. Both
 * paths end in a VISIBLE text note when nothing usable comes out — a PDF must never silently
 * vanish from the turn.
 */
export async function adaptContent(
  content: ContentPart[],
  caps: Pick<ModelCapabilities, "vision">,
): Promise<ContentPart[]> {
  const out: ContentPart[] = [];
  for (const part of content) {
    if (part.type !== "file") {
      out.push(part);
      continue;
    }
    const name = part.file.filename || "attachment.pdf";
    const fileData = part.file.file_data || "";

    if (fallbackModeValue === "images" && caps.vision) {
      try {
        const images = await rasterizeToImages(fileData);
        if (images.length > 0) {
          out.push({
            type: "text",
            text: `[Attached PDF: ${name} — ${images.length} page image(s), rendered locally]`,
          });
          for (const url of images) out.push({ type: "image_url", image_url: { url } });
          continue;
        }
      } catch {
        // Rasterization isn't available in this build (see rasterizeToImages's docstring) —
        // fall through to text extraction, mirroring the Python fallback's behavior when
        // pypdfium2 can't render a document.
      }
    }

    const text = await extractText(fileData);
    if (text) {
      out.push({
        type: "text",
        text: `[Attached PDF: ${name} — text extracted locally; this model has no native PDF support]\n${text}`,
      });
    } else {
      out.push({
        type: "text",
        text: `[Attached PDF: ${name} — no extractable text (likely scanned). A model with native PDF support (Claude, GPT, Gemini) can read it.]`,
      });
    }
  }
  return out;
}
