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

export function groupByDomain(entities: Entity[]): Array<[string, Entity[]]> {
  const m = new Map<string, Entity[]>();
  for (const e of entities) {
    const d = domainOf(e.entity_id);
    (m.get(d) ?? m.set(d, []).get(d)!).push(e);
  }
  const rank = (d: string) => {
    const i = ORDER.indexOf(d);
    return i === -1 ? ORDER.length : i;
  };
  return [...m.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([d, list]) => [d, list.sort((x, y) => friendlyName(x).localeCompare(friendlyName(y)))]);
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
