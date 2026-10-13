import { listAllSessions } from "./sessions.js";
import { listRepos } from "./catalog.js";
import { getAdapter } from "./agents/registry.js";
import type { UsageTurn } from "./agents/types.js";

export interface UsageTurnWithContext extends UsageTurn {
  cwd: string;
  sessionId: string;
}

interface TurnsCache {
  turns: UsageTurnWithContext[];
  builtAt: number;
}
let cache: TurnsCache | null = null;
// Reading every terminal session's full transcript file is real I/O (a long-running session's
// JSONL can be sizeable) — this cache is what keeps opening the dashboard, then flipping its
// 7d/30d/90d toggle a few times, from re-parsing every file on every click. Short enough that a
// session active RIGHT NOW still shows up within half a minute, not a real "is this stale" risk
// for a usage dashboard (unlike, say, session status).
const CACHE_TTL_MS = 30_000;

/**
 * Every billed turn across every terminal session this build knows how to price (currently
 * Claude Code only — see agents/types.ts's getUsageTurns doc comment and pricing.ts). Chat
 * sessions (Pi/owned-engine) aren't included: neither backend computes a real per-turn cost
 * today (see ownedEngine.ts's own "cost is always 0, honest" comment), so there's nothing real
 * to aggregate from them yet.
 */
async function collectAllTurns(): Promise<UsageTurnWithContext[]> {
  if (cache && Date.now() - cache.builtAt < CACHE_TTL_MS) return cache.turns;

  const sessions = await listAllSessions();
  const turns: UsageTurnWithContext[] = [];
  for (const s of sessions) {
    if (s.type !== "terminal" || !s.agentKind) continue;
    const adapter = getAdapter(s.agentKind);
    if (!adapter.getUsageTurns) continue;
    // Claude is the only adapter with canForceSessionId right now, and discoverExternalSessionId
    // is "never called for Claude" (see agents/types.ts) — its catalog id IS the external id,
    // same fallback agents/registry.ts's own resolveExternalSessionId uses when no override row
    // exists. Skipped entirely for any future adapter that implements getUsageTurns but isn't
    // forced-id, rather than guessing at an external id this function has no way to resolve.
    if (!adapter.canForceSessionId) continue;
    for (const turn of adapter.getUsageTurns(s.cwd, s.id)) {
      turns.push({ ...turn, cwd: s.cwd, sessionId: s.id });
    }
  }
  cache = { turns, builtAt: Date.now() };
  return turns;
}

function dateKey(d: Date): string {
  // Local calendar date, NOT toISOString().slice(0, 10) (that's UTC) — every other date
  // computation in this file (startOfDay, addDays, mondayOf, and the getDay()-based heatmap/
  // busiest-day bucketing below) is local-time, and this used to be the one UTC holdout. Any
  // turn near local midnight in a non-UTC timezone has a different UTC date than local date, so
  // the old version put it in a different day bucket than the heatmap/busiest-day tile did for
  // the exact same turn — e.g. Sessions by Day showing Tuesday while Busiest day said Monday for
  // what was actually one Monday-evening (locally) session.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

export interface DailyPoint {
  date: string;
  label: string;
  costUsd: number;
  tokens: number;
  sessionCount: number;
}

function bucketByDay(turns: UsageTurnWithContext[], from: Date, to: Date): DailyPoint[] {
  const byDay = new Map<string, { costUsd: number; tokens: number; sessions: Set<string> }>();
  for (const t of turns) {
    if (t.timestamp < from || t.timestamp > to) continue;
    const key = dateKey(t.timestamp);
    const entry = byDay.get(key) ?? { costUsd: 0, tokens: 0, sessions: new Set<string>() };
    entry.costUsd += t.costUsd;
    entry.tokens += t.tokens.input + t.tokens.output + t.tokens.cacheRead + t.tokens.cacheWrite;
    entry.sessions.add(t.sessionId);
    byDay.set(key, entry);
  }
  const points: DailyPoint[] = [];
  for (let d = startOfDay(from); d <= to; d = addDays(d, 1)) {
    const key = dateKey(d);
    const entry = byDay.get(key);
    points.push({
      date: key,
      label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      costUsd: entry?.costUsd ?? 0,
      tokens: entry?.tokens ?? 0,
      sessionCount: entry?.sessions.size ?? 0,
    });
  }
  return points;
}

export interface ModelBreakdown {
  model: string;
  costUsd: number;
  turns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function bucketByModel(turns: UsageTurnWithContext[]): ModelBreakdown[] {
  const byModel = new Map<string, ModelBreakdown>();
  for (const t of turns) {
    const entry = byModel.get(t.model) ?? { model: t.model, costUsd: 0, turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    entry.costUsd += t.costUsd;
    entry.turns += 1;
    entry.tokens.input += t.tokens.input;
    entry.tokens.output += t.tokens.output;
    entry.tokens.cacheRead += t.tokens.cacheRead;
    entry.tokens.cacheWrite += t.tokens.cacheWrite;
    byModel.set(t.model, entry);
  }
  return [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd);
}

export interface UsageSummary {
  todayCostUsd: number;
  rangeCostUsd: number;
  rangeTokens: number;
  dailyCost: DailyPoint[];
  byModel: ModelBreakdown[];
  updatedAt: string;
}

/** Powers the "Usage & Estimated Costs" panel — a rolling window ending today, not a calendar
 * week (unlike getWeeklyRewind below, which is deliberately calendar-week-aligned with
 * prev/next navigation). */
export async function getUsageSummary(rangeDays: 7 | 30 | 90): Promise<UsageSummary> {
  const turns = await collectAllTurns();
  const now = new Date();
  const from = startOfDay(addDays(now, -(rangeDays - 1)));
  const inRange = turns.filter((t) => t.timestamp >= from && t.timestamp <= now);
  const todayKey = dateKey(now);

  return {
    todayCostUsd: turns.filter((t) => dateKey(t.timestamp) === todayKey).reduce((sum, t) => sum + t.costUsd, 0),
    rangeCostUsd: inRange.reduce((sum, t) => sum + t.costUsd, 0),
    rangeTokens: inRange.reduce((sum, t) => sum + t.tokens.input + t.tokens.output + t.tokens.cacheRead + t.tokens.cacheWrite, 0),
    dailyCost: bucketByDay(turns, from, now),
    byModel: bucketByModel(inRange),
    updatedAt: now.toISOString(),
  };
}

export interface WeeklyRewind {
  weekStart: string;
  weekEnd: string;
  agentTimeMinutes: number;
  sessionCount: number;
  costUsd: number;
  peakWindowLabel: string | null;
  peakWindowSessionCount: number;
  topProjectName: string | null;
  topProjectSessionCount: number;
  busiestDayLabel: string | null;
  busiestDaySessionCount: number;
  sessionsByDay: DailyPoint[];
  costByDay: DailyPoint[];
  byModel: ModelBreakdown[];
  /** Mon=0..Sun=6 outer, 24 hourly counts inner — Activity Heatmap. */
  heatmap: number[][];
}

// Capped so a long idle gap between turns (stepped away, came back hours later) doesn't inflate
// "active agent time" — the same gap-capping heuristic a few other local-usage trackers use when
// there's no explicit session-start/stop event, only a stream of timestamped turns.
const ACTIVE_GAP_CAP_MS = 5 * 60 * 1000;

function estimateActiveMinutes(turns: UsageTurnWithContext[]): number {
  const bySession = new Map<string, Date[]>();
  for (const t of turns) {
    const list = bySession.get(t.sessionId) ?? [];
    list.push(t.timestamp);
    bySession.set(t.sessionId, list);
  }
  let totalMs = 0;
  for (const timestamps of bySession.values()) {
    timestamps.sort((a, b) => a.getTime() - b.getTime());
    for (let i = 1; i < timestamps.length; i++) {
      totalMs += Math.min(timestamps[i].getTime() - timestamps[i - 1].getTime(), ACTIVE_GAP_CAP_MS);
    }
  }
  return Math.round(totalMs / 60_000);
}

/** The Monday (local time) of the week `d` falls in — Weekly Rewind's weeks are always Mon-Sun,
 * matching the Sessions-by-Day/Cost-by-Day charts' own Mon..Sun axis. */
function mondayOf(d: Date): Date {
  const copy = startOfDay(d);
  const day = copy.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(copy, diff);
}

export async function getWeeklyRewind(weekStartIso?: string): Promise<WeeklyRewind> {
  const turns = await collectAllTurns();
  const weekStart = weekStartIso ? startOfDay(new Date(weekStartIso)) : mondayOf(new Date());
  const weekEnd = new Date(addDays(weekStart, 7).getTime() - 1); // Sunday 23:59:59.999
  const inWeek = turns.filter((t) => t.timestamp >= weekStart && t.timestamp <= weekEnd);
  const sessionIds = new Set(inWeek.map((t) => t.sessionId));

  const repos = await listRepos();
  const nameByPath = new Map(repos.map((r) => [r.localPath, r.name] as const));

  const sessionsByCwd = new Map<string, Set<string>>();
  const sessionsByDow = new Map<number, Set<string>>();
  const sessionsByHour = new Map<number, Set<string>>();
  const heatmap: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const t of inWeek) {
    const cwdSet = sessionsByCwd.get(t.cwd) ?? new Set<string>();
    cwdSet.add(t.sessionId);
    sessionsByCwd.set(t.cwd, cwdSet);

    const jsDow = t.timestamp.getDay(); // 0=Sun..6=Sat
    const dow = jsDow === 0 ? 6 : jsDow - 1; // Mon=0..Sun=6, matching the chart axis
    const dowSet = sessionsByDow.get(dow) ?? new Set<string>();
    dowSet.add(t.sessionId);
    sessionsByDow.set(dow, dowSet);

    const hour = t.timestamp.getHours();
    const hourSet = sessionsByHour.get(hour) ?? new Set<string>();
    hourSet.add(t.sessionId);
    sessionsByHour.set(hour, hourSet);

    heatmap[dow][hour] += 1;
  }

  let topProject: { cwd: string; count: number } | null = null;
  for (const [cwd, set] of sessionsByCwd) {
    if (!topProject || set.size > topProject.count) topProject = { cwd, count: set.size };
  }

  const DOW_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  let busiestDow: { dow: number; count: number } | null = null;
  for (const [dow, set] of sessionsByDow) {
    if (!busiestDow || set.size > busiestDow.count) busiestDow = { dow, count: set.size };
  }

  // Best 3-hour rolling window by distinct-session count — "8–11 PM" rather than a single busiest
  // hour, same granularity a peak-usage-window stat usually reads at.
  let peakWindow: { startHour: number; count: number } | null = null;
  for (let h = 0; h < 24; h++) {
    const count = new Set([...(sessionsByHour.get(h) ?? []), ...(sessionsByHour.get((h + 1) % 24) ?? []), ...(sessionsByHour.get((h + 2) % 24) ?? [])]).size;
    if (count > 0 && (!peakWindow || count > peakWindow.count)) peakWindow = { startHour: h, count };
  }
  const formatHour = (h: number) => {
    const period = h < 12 ? "AM" : "PM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12} ${period}`;
  };

  const weekSessionList = [...sessionIds];
  return {
    weekStart: dateKey(weekStart),
    weekEnd: dateKey(weekEnd),
    agentTimeMinutes: estimateActiveMinutes(inWeek),
    sessionCount: weekSessionList.length,
    costUsd: inWeek.reduce((sum, t) => sum + t.costUsd, 0),
    peakWindowLabel: peakWindow ? `${formatHour(peakWindow.startHour)}–${formatHour((peakWindow.startHour + 3) % 24)}` : null,
    peakWindowSessionCount: peakWindow?.count ?? 0,
    topProjectName: topProject ? (nameByPath.get(topProject.cwd) ?? topProject.cwd.split("/").pop() ?? topProject.cwd) : null,
    topProjectSessionCount: topProject?.count ?? 0,
    busiestDayLabel: busiestDow ? DOW_LABELS[busiestDow.dow] : null,
    busiestDaySessionCount: busiestDow?.count ?? 0,
    sessionsByDay: bucketByDay(inWeek, weekStart, weekEnd),
    costByDay: bucketByDay(inWeek, weekStart, weekEnd),
    byModel: bucketByModel(inWeek),
    heatmap,
  };
}
