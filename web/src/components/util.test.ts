import { describe, expect, it } from 'vitest';
import type { Entity } from '../client';
import { DEFAULT_PREFS, organize } from './util';

const e = (entity_id: string, name: string, last_changed = '2026-01-01T00:00:00Z'): Entity => ({
  entity_id,
  state: 'on',
  attributes: { friendly_name: name },
  last_changed,
});
const all = [
  e('sensor.temp', 'Temp', '2026-01-03T00:00:00Z'),
  e('light.b', 'Bedroom', '2026-01-01T00:00:00Z'),
  e('light.a', 'Attic', '2026-01-02T00:00:00Z'),
  e('switch.fan', 'Fan'),
];
const ids = (s: ReturnType<typeof organize>) => s.map(([k, , l]) => [k, l.map((x) => x.entity_id)]);

describe('organize', () => {
  it('groups by domain in fixed order, sorted by name', () => {
    expect(ids(organize(all, '', DEFAULT_PREFS))).toEqual([
      ['light', ['light.a', 'light.b']],
      ['switch', ['switch.fan']],
      ['sensor', ['sensor.temp']],
    ]);
  });
  it('favourites first, hidden dropped, recent sort, no grouping', () => {
    const p = { ...DEFAULT_PREFS, sort: 'recent' as const, group: 'none' as const, favs: ['switch.fan'], hidden: ['light.b'] };
    expect(ids(organize(all, '', p))).toEqual([
      ['_fav', ['switch.fan']],
      ['_all', ['sensor.temp', 'light.a']],
    ]);
    expect(ids(organize(all, '', { ...p, showHidden: true }))[1][1]).toContain('light.b');
  });
  it('applies the text filter', () => {
    expect(ids(organize(all, 'att', DEFAULT_PREFS))).toEqual([['light', ['light.a']]]);
  });
});
