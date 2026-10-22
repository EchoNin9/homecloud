import type { Entity } from '../client';

export const domainOf = (entityId: string): string => entityId.split('.')[0] ?? '';

export function friendlyName(e: Entity): string {
  const n = e.attributes.friendly_name;
  return typeof n === 'string' && n ? n : e.entity_id;
}

const ORDER = ['light', 'switch', 'fan', 'climate', 'cover', 'scene', 'sensor', 'binary_sensor'];
const TITLES: Record<string, string> = {
  light: 'Lights',
  switch: 'Switches',
  fan: 'Fans',
  climate: 'Climate',
  cover: 'Covers',
  scene: 'Scenes',
  sensor: 'Sensors',
  binary_sensor: 'Binary sensors',
};

export function domainTitle(d: string): string {
  return TITLES[d] ?? d.charAt(0).toUpperCase() + d.slice(1).replace(/_/g, ' ');
}

export type SortKey = 'name' | 'recent';
export type GroupKey = 'domain' | 'none';

export interface ViewPrefs {
  sort: SortKey;
  group: GroupKey;
  favs: string[];
  hidden: string[];
  showHidden: boolean;
}

export const DEFAULT_PREFS: ViewPrefs = { sort: 'name', group: 'domain', favs: [], hidden: [], showHidden: false };

/** One rendered section: [key, title, entities]. */
export type Section = [string, string, Entity[]];

const byName = (x: Entity, y: Entity) => friendlyName(x).localeCompare(friendlyName(y));
const changedMs = (e: Entity) => Date.parse(e.last_changed) || 0;
const byRecent = (x: Entity, y: Entity) => changedMs(y) - changedMs(x) || byName(x, y);

const domainRank = (d: string) => {
  const i = ORDER.indexOf(d);
  return i === -1 ? ORDER.length : i;
};

/** Filter, hide, sort and group entities. Favourites get their own first section. */
export function organize(entities: Entity[], filter: string, p: ViewPrefs): Section[] {
  const favs = new Set(p.favs);
  const hidden = new Set(p.hidden);
  const cmp = p.sort === 'recent' ? byRecent : byName;
  const shown = entities.filter((e) => (p.showHidden || !hidden.has(e.entity_id)) && matchesFilter(e, filter)).sort(cmp);
  const out: Section[] = [];
  const fav = shown.filter((e) => favs.has(e.entity_id));
  if (fav.length) out.push(['_fav', 'Favourites', fav]);
  const rest = shown.filter((e) => !favs.has(e.entity_id));
  if (p.group === 'none') {
    if (rest.length) out.push(['_all', fav.length ? 'Everything else' : 'All', rest]);
    return out;
  }
  const m = new Map<string, Entity[]>();
  for (const e of rest) {
    const d = domainOf(e.entity_id);
    (m.get(d) ?? m.set(d, []).get(d)!).push(e);
  }
  const groups = [...m.entries()].sort(([a], [b]) => domainRank(a) - domainRank(b) || a.localeCompare(b));
  return out.concat(groups.map(([d, list]): Section => [d, domainTitle(d), list]));
}

export function matchesFilter(e: Entity, q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  return friendlyName(e).toLowerCase().includes(needle) || e.entity_id.toLowerCase().includes(needle);
}

export function formatLastSeen(ts: number | null | undefined, nowMs = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.round((nowMs - ts) / 1000);
  if (s < 10) return 'just now';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 60) return rtf.format(-s, 'second');
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
