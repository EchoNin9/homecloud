import type { DayPoint, History, HistoryRes, RawPoint } from '../client';

export const DAY_MS = 86_400_000;

export type Range = '24h' | '7d' | '30d' | '15mo';
export const RANGES: Record<Range, { res: HistoryRes; ms: number; label: string }> = {
  '24h': { res: 'raw', ms: DAY_MS, label: '24 h' },
  '7d': { res: 'raw', ms: 7 * DAY_MS, label: '7 days' },
  '30d': { res: 'day', ms: 30 * DAY_MS, label: '30 days' },
  '15mo': { res: 'day', ms: 457 * DAY_MS, label: '15 months' },
};

/** States drawn as "active" in timelines and counted as hours in daily bars. */
const ACTIVE = new Set(['on', 'open', 'opening', 'above_horizon', 'running', 'home', 'playing', 'unlocked', 'detected', 'heat', 'cool']);
export const isActive = (s: string | null) => s !== null && ACTIVE.has(s);

/** history_entities globs (`*` only) -> does this entity have history? */
export function isTracked(entityId: string, globs: readonly string[] | undefined): boolean {
  return (globs ?? []).some((g) => new RegExp(`^${g.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(entityId));
}

const num = (s: string | null | undefined) => {
  if (s === null || s === undefined || s.trim() === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

export type Model =
  | { kind: 'empty' }
  /** Numeric raw: a step line (a value holds until the next change). */
  | { kind: 'line'; from: number; to: number; pts: { t: number; v: number }[]; min: number; max: number }
  /** Non-numeric raw: coloured state segments. */
  | { kind: 'timeline'; from: number; to: number; segs: { a: number; b: number; state: string }[]; active: string | null }
  /** Numeric daily: min–max band plus the time-weighted average. */
  | { kind: 'band'; days: { t: number; date: string; min: number; max: number; avg: number }[]; min: number; max: number }
  /** Non-numeric daily: hours per day in the active state. */
  | { kind: 'bars'; days: { t: number; date: string; hours: number }[]; state: string };

/**
 * API history -> what to draw. Every "nothing usable" path returns { kind: 'empty' }.
 * `current` (the entity's state and last_changed) fills a raw window with no changes: if it last
 * changed before the window ended, that state held the whole time. That covers stable entities and
 * the first hours after a fresh deploy, before any change is recorded.
 */
export function historyModel(h: History | null | undefined, nowMs = Date.now(), current?: RawPoint): Model {
  if (!h || !Array.isArray(h.points)) return { kind: 'empty' };
  if (h.res === 'day') return dayModel(h.points as DayPoint[]);
  const to = Math.min(h.to, nowMs);
  const fill = !h.points.length && !h.prev && current && Date.parse(current.t) <= to ? current : null;
  return rawModel(h.prev ?? fill, h.points as RawPoint[], h.from, to);
}

function rawModel(prev: RawPoint | null, points: RawPoint[], from: number, to: number): Model {
  const samples = (prev ? [prev, ...points] : points)
    .map((p) => ({ t: Date.parse(p.t), state: p.state }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  if (!samples.length || to <= from) return { kind: 'empty' };
  const nums = samples.map((p) => ({ t: Math.max(p.t, from), v: num(p.state) })).filter((p): p is { t: number; v: number } => p.v !== null);
  if (nums.length) {
    const vs = nums.map((p) => p.v);
    return { kind: 'line', from, to, pts: nums, min: Math.min(...vs), max: Math.max(...vs) };
  }
  const segs = samples
    .map((p, i) => ({ a: Math.max(p.t, from), b: Math.min(samples[i + 1]?.t ?? to, to), state: p.state ?? 'unknown' }))
    .filter((s) => s.b > s.a);
  if (!segs.length) return { kind: 'empty' };
  return { kind: 'timeline', from, to, segs, active: segs.find((s) => isActive(s.state))?.state ?? null };
}

function dayModel(points: DayPoint[]): Model {
  const ok = points.filter((p) => typeof p.date === 'string' && Number.isFinite(Date.parse(`${p.date}T12:00:00Z`)));
  const t = (p: DayPoint) => Date.parse(`${p.date}T12:00:00Z`);
  const numeric = ok.filter((p) => [p.min, p.max, p.avg].every((v) => typeof v === 'number' && Number.isFinite(v)));
  if (numeric.length) {
    const days = numeric.map((p) => ({ t: t(p), date: p.date, min: p.min!, max: p.max!, avg: p.avg! }));
    return { kind: 'band', days, min: Math.min(...days.map((d) => d.min)), max: Math.max(...days.map((d) => d.max)) };
  }
  const withDur = ok.filter((p) => p.dur && typeof p.dur === 'object');
  if (!withDur.length) return { kind: 'empty' };
  const keys = [...new Set(withDur.flatMap((p) => Object.keys(p.dur!)))];
  const state = keys.find((k) => ACTIVE.has(k)) ?? keys[0]!;
  return { kind: 'bars', state, days: withDur.map((p) => ({ t: t(p), date: p.date, hours: (Number(p.dur![state]) || 0) / 3600 })) };
}
