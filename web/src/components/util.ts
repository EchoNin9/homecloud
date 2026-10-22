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

/** Area name the bridge adds (contract: `homecloud_area`), or '' if none. */
export function areaOf(e: Entity): string {
  const a = e.attributes.homecloud_area;
  return typeof a === 'string' ? a : '';
}

export type SortKey = 'name' | 'recent';
export type GroupKey = 'domain' | 'area' | 'custom' | 'none';

export interface ViewPrefs {
  sort: SortKey;
  group: GroupKey;
  favs: string[];
  hidden: string[];
  /** Named custom groups: name -> entity ids. An entity can be in several. */
  groups: Record<string, string[]>;
  showHidden: boolean;
}

export const DEFAULT_PREFS: ViewPrefs = { sort: 'name', group: 'domain', favs: [], hidden: [], groups: {}, showHidden: false };

/** One rendered section: [key, title, entities]. */
export type Section = [string, string, Entity[]];

const byName = (x: Entity, y: Entity) => friendlyName(x).localeCompare(friendlyName(y));
const changedMs = (e: Entity) => Date.parse(e.last_changed) || 0;
const byRecent = (x: Entity, y: Entity) => changedMs(y) - changedMs(x) || byName(x, y);

const domainRank = (d: string) => {
  const i = ORDER.indexOf(d);
  return i === -1 ? ORDER.length : i;
};

/** Filter, hide, sort and group entities. Favourites come first; hidden ones (if shown) last. */
export function organize(entities: Entity[], filter: string, p: ViewPrefs): Section[] {
  const hidden = new Set(p.hidden);
  const cmp = p.sort === 'recent' ? byRecent : byName;
  const matching = entities.filter((e) => matchesFilter(e, filter)).sort(cmp);
  const out = grouped(matching.filter((e) => !hidden.has(e.entity_id)), p);
  const hid = matching.filter((e) => hidden.has(e.entity_id));
  if (p.showHidden && hid.length) out.push(['_hidden', 'Hidden', hid]);
  return out;
}

function grouped(shown: Entity[], p: ViewPrefs): Section[] {
  const favs = new Set(p.favs);
  const out: Section[] = [];
  const fav = shown.filter((e) => favs.has(e.entity_id));
  if (fav.length) out.push(['_fav', 'Favourites', fav]);
  const rest = shown.filter((e) => !favs.has(e.entity_id));
  if (p.group === 'none') {
    if (rest.length) out.push(['_all', fav.length ? 'Everything else' : 'All', rest]);
    return out;
  }
  if (p.group === 'custom') {
    const names = Object.keys(p.groups).sort((a, b) => a.localeCompare(b));
    const grouped = new Set(names.flatMap((n) => p.groups[n]));
    for (const n of names) {
      const ids = new Set(p.groups[n]);
      const list = rest.filter((e) => ids.has(e.entity_id));
      if (list.length) out.push([`grp:${n}`, n, list]);
    }
    const loose = rest.filter((e) => !grouped.has(e.entity_id));
    if (loose.length) out.push(['grp:', 'Ungrouped', loose]);
    return out;
  }
  const m = new Map<string, Entity[]>();
  if (p.group === 'area') {
    for (const e of rest) {
      const a = areaOf(e);
      (m.get(a) ?? m.set(a, []).get(a)!).push(e);
    }
    // Named areas A-Z, then entities with no area ('' key) last.
    const areas = [...m.entries()].sort(([a], [b]) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));
    return out.concat(areas.map(([a, list]): Section => [`area:${a}`, a || 'No area', list]));
  }
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
  return [friendlyName(e), e.entity_id, areaOf(e)].some((s) => s.toLowerCase().includes(needle));
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

// ponytail: warning rules are hard-coded; make them per-home settings if people want to tune them.
export const DOOR_OPEN_MS = 5 * 60_000;
export const DRIVE_MAX_C = 50;
const DOOR_CLASSES = new Set(['door', 'garage_door']);

export interface Warning {
  kind: 'door' | 'drive';
  entity: Entity;
  text: string;
}

const toC = (v: number, unit: unknown) => (typeof unit === 'string' && unit.includes('F') ? ((v - 32) * 5) / 9 : v);

/** Doors left open longer than DOOR_OPEN_MS, and drives hotter than DRIVE_MAX_C. */
export function warnings(entities: Entity[], nowMs = Date.now()): Warning[] {
  const out: Warning[] = [];
  for (const e of entities) {
    const a = e.attributes;
    if (domainOf(e.entity_id) === 'binary_sensor' && DOOR_CLASSES.has(String(a.device_class)) && e.state === 'on') {
      const since = Date.parse(e.last_changed);
      if (!since || nowMs - since >= DOOR_OPEN_MS) out.push({ kind: 'door', entity: e, text: `${friendlyName(e)} open` });
    } else if (domainOf(e.entity_id) === 'sensor' && /drive_\d+_temperature$/.test(e.entity_id)) {
      const v = Number(e.state);
      if (Number.isFinite(v) && toC(v, a.unit_of_measurement) > DRIVE_MAX_C) {
        out.push({ kind: 'drive', entity: e, text: `${friendlyName(e)} ${e.state}${a.unit_of_measurement ?? ''}` });
      }
    }
  }
  return out.sort((x, y) => (x.kind === y.kind ? x.text.localeCompare(y.text) : x.kind === 'door' ? -1 : 1));
}

/** "HH:MM" (24h) of HA's next sunrise/sunset from sun.sun, in the viewer's time zone. */
export function sunTimes(entities: Entity[], timeZone?: string): { rise?: string; set?: string } {
  const a = entities.find((e) => e.entity_id === 'sun.sun')?.attributes;
  const fmt = (v: unknown) => {
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isNaN(t) ? undefined : new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(t);
  };
  return { rise: fmt(a?.next_rising), set: fmt(a?.next_setting) };
}
