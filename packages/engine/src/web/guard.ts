/**
 * Address guard for URLs the model chooses.
 *
 * `web_fetch` (and, later, any `browser_open_url`-shaped tool) takes a URL straight from the
 * model, and the model's input is untrusted by design — it reads web pages, email and chat
 * messages, all of which are documented as "data, not instructions". A page that talks the
 * agent into fetching `http://169.254.169.254/` or `http://127.0.0.1:11434/` turns a
 * read-only research tool into a probe of the machine's own network position, and `web_fetch`
 * is `requiresApproval: false`, so no prompt ever appears. This module is what makes that safe.
 *
 * Ported from OpenWorker's coworker/web/guard.py. It blocks the ranges that are only
 * reachable *because* this engine runs on the user's machine: loopback, RFC1918 and other
 * IANA special-purpose space, link-local (which covers the cloud metadata endpoint at
 * 169.254.169.254 / fe80::-space equivalents), CGNAT (100.64.0.0/10 — Tailscale and similar
 * hand out internal hosts here too), and the multicast/reserved blocks.
 *
 * Every redirect hop is checked, not just the first: `fetchChecked` always sets
 * `redirect: "manual"` and walks the chain itself, because letting `fetch` auto-follow
 * redirects lets a public URL 302 straight to loopback — the standard way this kind of filter
 * gets bypassed.
 *
 * DEVIATION FROM THE PYTHON SOURCE (read this before trusting this module fully): the Python
 * guard closes DNS rebinding by *pinning the connection* — `get_checked` rewrites each hop so
 * httpx connects to the literal address that just passed the check, while still sending the
 * original Host header and TLS SNI name (via httpx's `sni_hostname` extension), so a DNS
 * record with a ~0 TTL that flips to 127.0.0.1 between the check and the connect changes
 * nothing: the client never resolves the name itself again. Node's global `fetch` (undici) has
 * no public equivalent of "connect to this exact address, but verify/SNI against this other
 * name" — doing that would mean reaching into undici internals (a custom `Agent`/`Client`
 * with a `connect` override), which is out of scope here. `fetchChecked` below instead
 * re-resolves and re-checks the hostname immediately before issuing each hop's request. That
 * closes the *redirect-to-loopback* bypass (the main real-world attack this guard exists for)
 * but leaves a narrow residual gap: a name whose DNS answer changes in the few microseconds
 * between this module's check and `fetch`'s own resolution could in principle still rebind.
 * `checkUrl` alone (a pre-check with no fetch attached) has always carried this same
 * resolve-twice gap, even in the Python original, for exactly the same reason — the caller
 * that eventually connects owns that connection, not the guard.
 *
 * Also note: `checkUrl` is `Promise<string | null>` here, not the synchronous `string | null`
 * of `check_url` in Python — Node's DNS resolution has no synchronous public API, so the
 * async wrapper is unavoidable, not a design choice.
 */
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";

export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Thrown by `fetchChecked` when a hop resolves to (or literally names) a blocked address. */
export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SsrfBlockedError";
  }
}

// ---------------------------------------------------------------------------------------
// IPv4 classification
// ---------------------------------------------------------------------------------------

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function inCidr4(ip: string, base: string, bits: number): boolean {
  const mask = bits <= 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

interface Cidr4 {
  base: string;
  bits: number;
  reason: string;
}

// Order mirrors guard.py's `_blocked_reason` priority (loopback, link-local, private, CGNAT,
// multicast, reserved) though only the first match is ever returned. The extra IANA
// special-purpose entries (protocol assignments, documentation, benchmarking) aren't named in
// the brief but are exactly what Python's `ipaddress.is_private` also catches — cheap to
// block and never a legitimate fetch target, so keeping them closes the same gap Python does.
const V4_BLOCKS: Cidr4[] = [
  { base: "127.0.0.0", bits: 8, reason: "loopback" },
  { base: "169.254.0.0", bits: 16, reason: "link-local (includes the cloud metadata endpoint)" },
  { base: "10.0.0.0", bits: 8, reason: "a private network" },
  { base: "172.16.0.0", bits: 12, reason: "a private network" },
  { base: "192.168.0.0", bits: 16, reason: "a private network" },
  { base: "100.64.0.0", bits: 10, reason: "shared address space (CGNAT / RFC 6598)" },
  { base: "0.0.0.0", bits: 8, reason: "a reserved range" }, // "this network" / unspecified
  { base: "192.0.0.0", bits: 24, reason: "a reserved range" }, // IETF protocol assignments
  { base: "192.0.2.0", bits: 24, reason: "a reserved range" }, // documentation (TEST-NET-1)
  { base: "198.18.0.0", bits: 15, reason: "a reserved range" }, // benchmarking
  { base: "198.51.100.0", bits: 24, reason: "a reserved range" }, // documentation (TEST-NET-2)
  { base: "203.0.113.0", bits: 24, reason: "a reserved range" }, // documentation (TEST-NET-3)
  { base: "224.0.0.0", bits: 4, reason: "multicast" },
  { base: "240.0.0.0", bits: 4, reason: "a reserved range" }, // class E + limited broadcast
];

function classifyV4(ip: string): string | null {
  for (const block of V4_BLOCKS) {
    if (inCidr4(ip, block.base, block.bits)) return block.reason;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// IPv6 classification
// ---------------------------------------------------------------------------------------

/** Expand any valid textual IPv6 address (including `::` shorthand and a trailing embedded
 * IPv4 tail like `::ffff:1.2.3.4`) into its 128-bit value. Throws on malformed input — callers
 * must treat that as "block, don't guess" rather than let it slip through unclassified. */
function expandIPv6(raw: string): bigint {
  let addr = raw;
  const v4Tail = addr.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Tail && isIP(v4Tail[1]) === 4) {
    const hex = ipv4ToInt(v4Tail[1]).toString(16).padStart(8, "0");
    addr = addr.slice(0, addr.length - v4Tail[1].length) + `${hex.slice(0, 4)}:${hex.slice(4)}`;
  }

  let headParts: string[];
  let tailParts: string[];
  if (addr.includes("::")) {
    const doubleColonCount = (addr.match(/::/g) ?? []).length;
    if (doubleColonCount > 1) throw new Error(`invalid IPv6 address: ${raw}`);
    const [head, tail] = addr.split("::");
    headParts = head ? head.split(":").filter((p) => p.length > 0) : [];
    tailParts = tail ? tail.split(":").filter((p) => p.length > 0) : [];
  } else {
    headParts = addr.split(":").filter((p) => p.length > 0);
    tailParts = [];
  }

  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) throw new Error(`invalid IPv6 address: ${raw}`);
  const groups = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  if (groups.length !== 8) throw new Error(`invalid IPv6 address: ${raw}`);

  let value = 0n;
  for (const group of groups) {
    const n = Number.parseInt(group, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) throw new Error(`invalid IPv6 address: ${raw}`);
    value = (value << 16n) | BigInt(n);
  }
  return value;
}

interface Cidr6 {
  base: bigint;
  bits: number;
  reason: string;
}

function v6(baseHex: string, bits: number, reason: string): Cidr6 {
  return { base: expandIPv6(baseHex), bits, reason };
}

const V6_BLOCKS: Cidr6[] = [
  v6("::1", 128, "loopback"),
  v6("::", 128, "a reserved range"), // unspecified address
  v6("fe80::", 10, "link-local (includes the cloud metadata endpoint)"),
  v6("fc00::", 7, "a private network"), // unique local addresses, RFC 4193
  v6("ff00::", 8, "multicast"),
  v6("100::", 64, "a reserved range"), // discard-only prefix, RFC 6666
  v6("2001:db8::", 32, "a reserved range"), // documentation, RFC 3849
];

const V4_MAPPED_PREFIX = expandIPv6("::ffff:0:0") >> 32n;

function inCidr6(value: bigint, block: Cidr6): boolean {
  const shift = BigInt(128 - block.bits);
  return value >> shift === block.base >> shift;
}

/** If `value` is an IPv4-mapped IPv6 address (`::ffff:0:0/96`), the embedded dotted-quad —
 * mirrors Python's `ip.ipv4_mapped`, since `::ffff:127.0.0.1` must be judged as the v4
 * loopback address it carries, not waved through as "just some IPv6 address". */
function ipv4Mapped(value: bigint): string | null {
  if (value >> 32n !== V4_MAPPED_PREFIX) return null;
  const v4 = Number(value & 0xffffffffn);
  return [(v4 >>> 24) & 255, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join(".");
}

function classifyV6(raw: string): string | null {
  const zoneIdx = raw.indexOf("%");
  const clean = zoneIdx === -1 ? raw : raw.slice(0, zoneIdx);
  let value: bigint;
  try {
    value = expandIPv6(clean);
  } catch {
    return "an unparseable address";
  }
  const mapped = ipv4Mapped(value);
  if (mapped) return classifyV4(mapped);
  for (const block of V6_BLOCKS) {
    if (inCidr6(value, block)) return block.reason;
  }
  return null;
}

function classifyAddress(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return classifyV4(address);
  if (family === 6) return classifyV6(address);
  return "an unparseable address";
}

// ---------------------------------------------------------------------------------------
// URL vetting
// ---------------------------------------------------------------------------------------

interface VetResult {
  /** Refusal reason, or null when the URL may be fetched. */
  reason: string | null;
  /** Best-effort address to report/pin against — null for literal-IP URLs (the URL already
   * names the target) and otherwise the first resolved answer. Valid to treat as "the"
   * address because a refusal is returned as soon as *any* answer lands in a blocked range,
   * so a name with both a public and a private record can't slip through by luck of ordering. */
  pin: string | null;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

async function vet(url: string): Promise<VetResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { reason: "url must start with http:// or https://", pin: null };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { reason: "url must start with http:// or https://", pin: null };
  }
  const host = stripBrackets(parsed.hostname);
  if (!host) return { reason: "url has no host", pin: null };

  if (isIP(host) !== 0) {
    const reason = classifyAddress(host);
    return { reason: reason ? `refusing to fetch ${host}: ${reason}` : null, pin: null };
  }

  let records: LookupAddress[];
  try {
    records = await dnsLookup(host, { all: true, verbatim: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { reason: `could not resolve ${host}: ${message}`, pin: null };
  }
  if (records.length === 0) {
    return { reason: `could not resolve ${host}: no addresses`, pin: null };
  }

  let pin: string | null = null;
  for (const record of records) {
    const reason = classifyAddress(record.address);
    if (reason) {
      return { reason: `refusing to fetch ${host} (${record.address}): ${reason}`, pin: null };
    }
    if (pin === null) pin = record.address;
  }
  return { reason: null, pin };
}

/** `null` if the URL may be fetched, else a human-readable refusal reason. Resolves the host
 * and rejects when *any* answer lands in a blocked range. See the module docstring for why
 * this is `Promise<string | null>` rather than a synchronous check. */
export async function checkUrl(url: string): Promise<string | null> {
  return (await vet(url)).reason;
}

export interface FetchCheckedResult {
  response: Response;
  /** The final *logical* URL — the name that was actually fetched, after following any
   * redirects, not an address literal. */
  finalUrl: string;
}

/** GET (or whatever `init.method` says) `url`, validating and re-resolving the address before
 * every hop. `init.redirect` is always forced to `"manual"` — redirects are walked here so
 * each `Location` is itself checked, never handed to `fetch`'s own auto-follow. Throws
 * `SsrfBlockedError` when a hop is refused, plain `Error` when the redirect budget is
 * exhausted. See the module docstring for the residual DNS-rebinding gap this carries versus
 * the Python original's connection-pinned guard. */
export async function fetchChecked(
  url: string,
  init: RequestInit = {},
  options: { maxRedirects?: number } = {},
): Promise<FetchCheckedResult> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { reason } = await vet(current);
    if (reason) throw new SsrfBlockedError(reason);

    const response = await fetch(current, { ...init, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: current };
    }
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current };
    // Resolved against the logical URL just fetched, not `response.url` — a relative
    // Location must stay anchored to the hop that issued it.
    current = new URL(location, current).toString();
  }
  throw new Error(`too many redirects (>${maxRedirects})`);
}
