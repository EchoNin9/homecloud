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
  update: 'Updates',
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
  /** Named custom groups: name -> hand-picked entity ids. An entity can be in several. */
  groups: Record<string, string[]>;
  /** Live groups: name -> search; every entity matching it is a member too. */
  groupQueries: Record<string, string>;
  /** Members removed by hand from a live group although they match its search. */
  groupOut: Record<string, string[]>;
  /** Saved filter texts, newest first, at most MAX_QUERIES. */
  queries: string[];
  showHidden: boolean;
  /** With group 'custom': show only this group ('' = all groups). */
  only: string;
}

export const DEFAULT_PREFS: ViewPrefs = { sort: 'name', group: 'domain', favs: [], hidden: [], groups: {}, queries: [], showHidden: false, only: '', groupQueries: {}, groupOut: {} };
export const MAX_QUERIES = 15;

/** Add q to the saved list (newest first, no duplicates). Null when full. */
export function saveQuery(list: string[], q: string): string[] | null {
  const t = q.trim();
  if (!t) return list;
  const rest = list.filter((x) => x !== t);
  return rest.length >= MAX_QUERIES ? null : [t, ...rest];
}

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
  if (p.group === 'custom' && p.only) {
    // One group on its own: every member, favourites and hidden ones (dimmed) included, nothing else.
    const ids = groupIds(p.only, matching, p);
    const list = matching.filter((e) => ids.has(e.entity_id));
    return list.length ? [[`grp:${p.only}`, p.only, list]] : [];
  }
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
    const sets = new Map(names.map((n) => [n, groupIds(n, rest, p)]));
    const grouped = new Set([...sets.values()].flatMap((x) => [...x]));
    for (const n of names) {
      const ids = sets.get(n)!;
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
  kind: 'door' | 'service' | 'drive' | 'update';
  entity: Entity;
  text: string;
}

/** "NAS2 (Drive 1) Temperature" -> "NAS2 Drive 1". */
const driveLabel = (n: string) => n.replace(/\s*temperature$/i, '').replace(/[()]/g, '').replace(/\s+/g, ' ').trim();

const toC = (v: number, unit: unknown) => (typeof unit === 'string' && unit.includes('F') ? ((v - 32) * 5) / 9 : v);

/** Doors left open longer than DOOR_OPEN_MS, NAS containers not running/healthy, and drives hotter than DRIVE_MAX_C. */
export function warnings(entities: Entity[], nowMs = Date.now()): Warning[] {
  const out: Warning[] = [];
  for (const e of entities) {
    const a = e.attributes;
    if (domainOf(e.entity_id) === 'binary_sensor' && DOOR_CLASSES.has(String(a.device_class)) && e.state === 'on') {
      const since = Date.parse(e.last_changed);
      if (!since || nowMs - since >= DOOR_OPEN_MS) out.push({ kind: 'door', entity: e, text: `${friendlyName(e)} open` });
    } else if (e.entity_id.startsWith('sensor.docker_')) {
      const bad = e.state !== 'running' ? e.state : a.health === 'unhealthy' ? 'unhealthy' : '';
      if (bad) out.push({ kind: 'service', entity: e, text: `${friendlyName(e)} · ${bad}` });
    } else if (domainOf(e.entity_id) === 'update' && e.state === 'on') {
      const u = updateInfo(e);
      const text = !u.container ? `${u.service} → ${u.to}` : u.digest ? `${u.service} · new :${u.from}` : `${u.service} ${u.from} → ${u.to}`;
      out.push({ kind: 'update', entity: e, text });
    } else if (domainOf(e.entity_id) === 'sensor' && /drive_\d+_temperature$/.test(e.entity_id)) {
      const v = Number(e.state);
      if (Number.isFinite(v) && toC(v, a.unit_of_measurement) > DRIVE_MAX_C) {
        out.push({ kind: 'drive', entity: e, text: `${driveLabel(friendlyName(e))} · ${e.state}${a.unit_of_measurement ?? ''}` });
      }
    }
  }
  const rank = { door: 0, service: 1, drive: 2, update: 3 };
  return out.sort((x, y) => rank[x.kind] - rank[y.kind] || x.text.localeCompare(y.text));
}

export interface UpdateInfo {
  /** A NAS container (from the update checker). Other HA updates (DSM, firmware) install from their own UI. */
  container: boolean;
  service: string;
  from: string;
  to: string;
  /** Same tag, new image (e.g. `:stable`): pull it. Otherwise the tag in docker-compose.yml must change. */
  digest: boolean;
  url: string | null;
  /** Shell commands to run in the NAS stack folder (after editing the tag when !digest). */
  steps: string[];
}

/** HA `update.*` entity (from the NAS update checker) -> what to tell the user to run. */
export function updateInfo(e: Entity): UpdateInfo {
  const a = e.attributes;
  // ponytail: compose names containers <project>-<service>-<n>; a project name containing '-' breaks this.
  const title = typeof a.title === 'string' && a.title ? a.title : friendlyName(e);
  const container = e.entity_id.startsWith('update.wud_container_');
  const service = container ? title.replace(/^[^-]+-/, '').replace(/-\d+$/, '') : friendlyName(e);
  const from = String(a.installed_version ?? '?');
  const to = String(a.latest_version ?? '?');
  const digest = to.startsWith('sha256:');
  const steps = !container
    ? []
    : digest
    ? [`sudo docker compose pull ${service}`, `sudo docker compose up -d ${service}`]
    : [`sudo docker compose up -d ${service}`];
  return { container, service, from, to, digest, url: typeof a.release_url === 'string' ? a.release_url : null, steps };
}

const RAD = Math.PI / 180;
const J1970 = 2440587.5;
const J2000 = 2451545;

/** Sunrise/sunset (epoch ms) for the solar day `n` (days since J2000) — the sunrise equation. */
function sunDay(n: number, lat: number, lon: number): { rise: number; set: number; noon: number } | null {
  const jStar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const L = (M + C + 180 + 102.9372) % 360;
  const transit = J2000 + jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * L * RAD);
  const sinD = Math.sin(L * RAD) * Math.sin(23.4397 * RAD);
  const cosD = Math.cos(Math.asin(sinD));
  const cosW = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinD) / (Math.cos(lat * RAD) * cosD);
  if (cosW < -1 || cosW > 1) return null; // polar day or night
  const w = Math.acos(cosW) / RAD / 360;
  const ms = (j: number) => (j - J1970) * 86_400_000;
  return { rise: ms(transit - w), set: ms(transit + w), noon: ms(transit) };
}

/**
 * Today's sunrise/sunset as "HH:MM" (24h), in the viewer's time zone; rolls over at local
 * midnight. Uses the home location the bridge adds to sun.sun; without it, falls back to
 * HA's next_rising/next_setting.
 */
export function sunTimes(entities: Entity[], timeZone?: string, nowMs = Date.now()): { rise?: string; set?: string } {
  const a = entities.find((e) => e.entity_id === 'sun.sun')?.attributes;
  if (!a) return {};
  const hhmm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
  const fmt = (t: number) => (Number.isFinite(t) ? hhmm.format(t) : undefined);
  const lat = a.homecloud_latitude;
  const lon = a.homecloud_longitude;
  if (typeof lat === 'number' && typeof lon === 'number') {
    const day = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone });
    const today = day.format(nowMs);
    const n0 = Math.round(nowMs / 86_400_000 + J1970 - J2000);
    for (const n of [n0 - 1, n0, n0 + 1]) {
      const d = sunDay(n, lat, lon);
      if (d && day.format(d.noon) === today) return { rise: fmt(d.rise), set: fmt(d.set) };
    }
    return {};
  }
  const parse = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : NaN);
  return { rise: fmt(parse(a.next_rising)), set: fmt(parse(a.next_setting)) };
}

/** HA state for display: "above_horizon" -> "Above horizon". Numbers pass through. */
export function prettyState(s: string): string {
  if (!s || /^-?\d/.test(s)) return s;
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const BINARY_WORDS: Record<string, [string, string]> = {
  motion: ['Detected', 'Clear'],
  door: ['Open', 'Closed'],
  garage_door: ['Open', 'Closed'],
  window: ['Open', 'Closed'],
  opening: ['Open', 'Closed'],
  occupancy: ['Occupied', 'Clear'],
  moisture: ['Wet', 'Dry'],
  smoke: ['Smoke', 'Clear'],
  problem: ['Problem', 'OK'],
};

const numAttr = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The tile's second line, as HA words it: "On · 49%", "44 °C", "Open", "v0.107.80 available". */
export function stateText(e: Entity, nowMs = Date.now()): string {
  const a = e.attributes;
  const s = e.state;
  if (s === 'unavailable' || s === 'unknown') return prettyState(s);
  const unit = typeof a.unit_of_measurement === 'string' && a.unit_of_measurement ? ` ${a.unit_of_measurement}` : '';
  switch (domainOf(e.entity_id)) {
    case 'light': {
      const b = numAttr(a.brightness);
      return s === 'on' && b !== undefined ? `On · ${Math.round((b / 255) * 100)}%` : prettyState(s);
    }
    case 'climate': {
      const cur = numAttr(a.current_temperature);
      const u = String(a.temperature_unit ?? a.unit_of_measurement ?? '°');
      const what = prettyState(typeof a.hvac_action === 'string' ? a.hvac_action : s);
      return cur === undefined ? what : `${what} · ${cur} ${u}`;
    }
    case 'scene': {
      const t = Date.parse(s);
      return Number.isFinite(t) ? `Activated ${formatLastSeen(t, nowMs)}` : 'Scene';
    }
    case 'binary_sensor': {
      const w = BINARY_WORDS[String(a.device_class)] ?? ['On', 'Off'];
      return s === 'on' ? w[0] : s === 'off' ? w[1] : prettyState(s);
    }
    case 'update': {
      if (s !== 'on') return 'Up to date';
      const to = String(a.latest_version ?? '');
      return to.startsWith('sha256:') || !to ? 'New image available' : `${to} available`;
    }
    case 'sensor':
      return `${prettyState(s)}${unit}`;
    default:
      return prettyState(s);
  }
}

/** Members of a group among `entities`: hand-picked ids plus live-search matches, minus ones removed by hand. */
export function groupIds(name: string, entities: Entity[], p: ViewPrefs): Set<string> {
  const out = new Set(p.groupOut?.[name] ?? []);
  const q = p.groupQueries?.[name]?.trim() ?? '';
  const ids = new Set((p.groups[name] ?? []).filter((id) => !out.has(id)));
  if (q) for (const e of entities) if (!out.has(e.entity_id) && matchesFilter(e, q)) ids.add(e.entity_id);
  return ids;
}

/**
 * Prefs patch that adds (on) or removes `ids` from a group. A live-search match is removed by
 * listing it in groupOut; anything else is a hand-picked id. A group with no ids and no search goes away.
 */
export function setMembers(p: ViewPrefs, name: string, ids: string[], on: boolean, entities: Entity[]): Partial<ViewPrefs> {
  const q = p.groupQueries[name]?.trim() ?? '';
  const byId = new Map(entities.map((e) => [e.entity_id, e]));
  const matches = (id: string) => !!q && !!byId.get(id) && matchesFilter(byId.get(id)!, q);
  let manual = p.groups[name] ?? [];
  let out = p.groupOut[name] ?? [];
  if (on) {
    out = out.filter((id) => !ids.includes(id));
    manual = [...new Set([...manual, ...ids.filter((id) => !matches(id))])];
  } else {
    manual = manual.filter((id) => !ids.includes(id));
    out = [...new Set([...out, ...ids.filter(matches)])];
  }
  const { [name]: _g, ...groups } = p.groups;
  const { [name]: _o, ...groupOut } = p.groupOut;
  if (!manual.length && !q) {
    const { [name]: _q, ...groupQueries } = p.groupQueries;
    return { groups, groupOut, groupQueries };
  }
  return { groups: { ...groups, [name]: manual }, groupOut: out.length ? { ...groupOut, [name]: out } : groupOut };
}

/** Prefs patch that renames (to) or deletes (to = null) a group, with its search and removals. */
export function moveGroup(p: ViewPrefs, from: string, to: string | null): Partial<ViewPrefs> {
  const pick = <T>(r: Record<string, T>) => {
    const { [from]: v, ...rest } = r;
    return to && v !== undefined ? { ...rest, [to]: v } : rest;
  };
  return {
    groups: pick(p.groups), groupQueries: pick(p.groupQueries), groupOut: pick(p.groupOut),
    ...(p.only === from ? { only: to ?? '' } : {}),
  };
}
