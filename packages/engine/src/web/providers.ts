/**
 * Web search providers — a keyless default + pluggable third-party services.
 *
 * Ported from OpenWorker's coworker/web/providers.py. `DuckDuckGoProvider` there wraps the
 * `ddgs` PyPI package; the brief for this port is explicitly keyless-and-dependency-free, so
 * this implementation instead scrapes DuckDuckGo's no-JS HTML results page
 * (`html.duckduckgo.com/html/`) with a couple of small regexes — DEVIATION from the Python
 * source, noted in the module report. `TavilyProvider` and `BraveProvider` are direct,
 * fetch-based ports (they were already just an HTTP call in Python; no client library there
 * either). All providers return a uniform `SearchResult[]`.
 */

const TIMEOUT_MS = 20000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; metaharn-engine/0.1; +desktop) AppleWebKit/537.36";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  readonly name: string;
  search(query: string, maxResults?: number, signal?: AbortSignal): Promise<SearchResult[]>;
}

/** Combine a caller-provided abort signal (engine interrupts) with a per-call timeout, the
 * way every provider call in this package is expected to respect cancellation. */
function callSignal(external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

// ---------------------------------------------------------------------------------------
// DuckDuckGo (keyless)
// ---------------------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

/** DuckDuckGo's HTML result page wraps outbound links in `//duckduckgo.com/l/?uddg=<url>&...`
 * so it can log the click; unwrap that to the real target the way a browser would on click. */
function extractResultUrl(href: string): string {
  try {
    const absolute = href.startsWith("//") ? `https:${href}` : href;
    const parsed = new URL(absolute, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : parsed.toString();
  } catch {
    return href;
  }
}

function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const titles: Array<{ url: string; title: string }> = [];
  for (const m of html.matchAll(titleRe)) {
    titles.push({
      url: extractResultUrl(decodeEntities(m[1])),
      title: decodeEntities(stripTags(m[2])).trim(),
    });
  }
  // DuckDuckGo emits exactly one snippet link per result, in the same order as the title
  // links, so pairing by index (rather than parsing nested result blocks) is a "small
  // regex" approach that still stays correct.
  const snippets: string[] = [];
  for (const m of html.matchAll(snippetRe)) {
    snippets.push(decodeEntities(stripTags(m[1])).trim());
  }

  return titles
    .filter((t) => t.url.length > 0)
    .map((t, i) => ({ title: t.title, url: t.url, snippet: snippets[i] ?? "" }));
}

export class DuckDuckGoProvider implements WebSearchProvider {
  readonly name = "duckduckgo";

  async search(query: string, maxResults = 5, signal?: AbortSignal): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query });
    const resp = await fetch(`https://html.duckduckgo.com/html/?${params.toString()}`, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: callSignal(signal),
    });
    if (!resp.ok) throw new Error(`duckduckgo returned HTTP ${resp.status}`);
    const html = await resp.text();
    return parseDuckDuckGoHtml(html).slice(0, Math.max(1, maxResults));
  }
}

// ---------------------------------------------------------------------------------------
// Tavily (keyed)
// ---------------------------------------------------------------------------------------

interface TavilyResultRow {
  title?: string;
  url?: string;
  content?: string;
}

export class TavilyProvider implements WebSearchProvider {
  readonly name = "tavily";

  constructor(private readonly apiKey: string) {}

  async search(query: string, maxResults = 5, signal?: AbortSignal): Promise<SearchResult[]> {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: this.apiKey, query, max_results: maxResults }),
      signal: callSignal(signal),
    });
    if (!resp.ok) throw new Error(`tavily returned HTTP ${resp.status}`);
    const data = (await resp.json()) as { results?: TavilyResultRow[] };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
    }));
  }
}

// ---------------------------------------------------------------------------------------
// Brave (keyed)
// ---------------------------------------------------------------------------------------

interface BraveResultRow {
  title?: string;
  url?: string;
  description?: string;
}

export class BraveProvider implements WebSearchProvider {
  readonly name = "brave";

  constructor(private readonly apiKey: string) {}

  async search(query: string, maxResults = 5, signal?: AbortSignal): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, count: String(maxResults) });
    const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
      headers: { "X-Subscription-Token": this.apiKey, Accept: "application/json" },
      signal: callSignal(signal),
    });
    if (!resp.ok) throw new Error(`brave returned HTTP ${resp.status}`);
    const data = (await resp.json()) as { web?: { results?: BraveResultRow[] } };
    return (data.web?.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    }));
  }
}

// ---------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------

interface ProviderEntry {
  requiresKey: boolean;
  create: (apiKey?: string) => WebSearchProvider;
}

const PROVIDERS: Record<string, ProviderEntry> = {
  duckduckgo: { requiresKey: false, create: () => new DuckDuckGoProvider() },
  tavily: { requiresKey: true, create: (key) => new TavilyProvider(key as string) },
  brave: { requiresKey: true, create: (key) => new BraveProvider(key as string) },
};

export function buildProvider(name: string, apiKey?: string): WebSearchProvider {
  const entry = PROVIDERS[name] ?? PROVIDERS.duckduckgo;
  if (entry.requiresKey && !apiKey) {
    throw new Error(`web search provider "${name}" needs an API key`);
  }
  return entry.create(apiKey);
}

export function providerNames(): string[] {
  return Object.keys(PROVIDERS);
}
