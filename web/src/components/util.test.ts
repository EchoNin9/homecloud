import { describe, expect, it } from 'vitest';
import type { Entity } from '../client';
import { DEFAULT_PREFS, MAX_QUERIES, organize, prettyState, saveQuery, sunTimes, warnings } from './util';

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
    expect(ids(organize(all, '', { ...p, showHidden: true })).at(-1)).toEqual(['_hidden', ['light.b']]);
  });
  it('groups by area, no-area last', () => {
    const withArea = (x: Entity, a: string): Entity => ({ ...x, attributes: { ...x.attributes, homecloud_area: a } });
    const list = [withArea(all[0], 'Office'), withArea(all[1], 'Bedroom'), all[2]];
    expect(ids(organize(list, '', { ...DEFAULT_PREFS, group: 'area' }))).toEqual([
      ['area:Bedroom', ['light.b']],
      ['area:Office', ['sensor.temp']],
      ['area:', ['light.a']],
    ]);
  });
  it('custom groups: multi-membership, A-Z, ungrouped last', () => {
    const p = { ...DEFAULT_PREFS, group: 'custom' as const, groups: { Zed: ['light.a', 'light.b'], Alpha: ['light.a'], Empty: [] } };
    expect(ids(organize(all, '', p))).toEqual([
      ['grp:Alpha', ['light.a']],
      ['grp:Zed', ['light.a', 'light.b']],
      ['grp:', ['switch.fan', 'sensor.temp']],
    ]);
  });
  it('applies the text filter', () => {
    expect(ids(organize(all, 'att', DEFAULT_PREFS))).toEqual([['light', ['light.a']]]);
  });
});

describe('warnings', () => {
  const now = Date.parse('2026-01-01T01:00:00Z');
  const door = (id: string, state: string, changed: string, dc = 'door'): Entity => ({
    entity_id: id, state, last_changed: changed, attributes: { device_class: dc, friendly_name: id },
  });
  const temp = (id: string, state: string, unit = '°C'): Entity => ({
    entity_id: id, state, last_changed: '', attributes: { device_class: 'temperature', unit_of_measurement: unit, friendly_name: id },
  });
  it('flags doors open past the limit and hot drives only', () => {
    const w = warnings([
      door('binary_sensor.old', 'on', '2026-01-01T00:50:00Z'),
      door('binary_sensor.fresh', 'on', '2026-01-01T00:58:00Z'),
      door('binary_sensor.shut', 'off', '2026-01-01T00:00:00Z'),
      door('binary_sensor.motion', 'on', '2026-01-01T00:00:00Z', 'motion'),
      temp('sensor.nas_drive_1_temperature', '51'),
      temp('sensor.nas_drive_2_temperature', '50'),
      temp('sensor.nas_drive_3_temperature', '130', '°F'),
      temp('sensor.nas_temperature', '70'),
      { entity_id: 'sensor.docker_hc_up', state: 'running', last_changed: '', attributes: { health: 'healthy' } },
      { entity_id: 'sensor.docker_hc_sick', state: 'running', last_changed: '', attributes: { health: 'unhealthy' } },
      { entity_id: 'sensor.docker_hc_dead', state: 'exited', last_changed: '', attributes: {} },
    ], now);
    expect(w.map((x) => [x.kind, x.entity.entity_id])).toEqual([
      ['door', 'binary_sensor.old'],
      ['service', 'sensor.docker_hc_dead'],
      ['service', 'sensor.docker_hc_sick'],
      ['drive', 'sensor.nas_drive_1_temperature'],
      ['drive', 'sensor.nas_drive_3_temperature'],
    ]);
  });
});

describe('sunTimes', () => {
  const sun = (attrs: Record<string, unknown>): Entity => ({ entity_id: 'sun.sun', state: 'above_horizon', last_changed: '', attributes: attrs });
  const mins = (hhmm?: string) => (hhmm ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) : NaN);
  it("computes today's times from the home location (within 3 min of published tables)", () => {
    // London, 2026-03-20: sunrise ~06:02, sunset ~18:14 GMT.
    const ldn = sun({ homecloud_latitude: 51.5074, homecloud_longitude: -0.1278 });
    const r = sunTimes([ldn], 'Europe/London', Date.parse('2026-03-20T21:00:00Z'));
    expect(Math.abs(mins(r.rise) - (6 * 60 + 2))).toBeLessThanOrEqual(3);
    expect(Math.abs(mins(r.set) - (18 * 60 + 14))).toBeLessThanOrEqual(3);
    // Same day, early morning, still the same day's values; next day differs.
    expect(sunTimes([ldn], 'Europe/London', Date.parse('2026-03-20T00:10:00Z'))).toEqual(r);
    expect(sunTimes([ldn], 'Europe/London', Date.parse('2026-03-21T00:10:00Z'))).not.toEqual(r);
  });
  it('falls back to next_rising/next_setting without a location', () => {
    const s = sun({ next_rising: '2026-10-22T11:28:00+00:00', next_setting: '2026-10-22T22:15:00+00:00' });
    expect(sunTimes([s], 'America/Toronto')).toEqual({ rise: '07:28', set: '18:15' });
    expect(sunTimes([])).toEqual({});
  });
});

describe('prettyState', () => {
  it('humanizes words, leaves numbers', () => {
    expect(prettyState('above_horizon')).toBe('Above horizon');
    expect(prettyState('12.4')).toBe('12.4');
    expect(prettyState('-3')).toBe('-3');
  });
});

describe('saveQuery', () => {
  it('dedupes newest-first, ignores blanks, refuses past the max', () => {
    expect(saveQuery(['a', 'b'], ' b ')).toEqual(['b', 'a']);
    expect(saveQuery(['a'], '  ')).toEqual(['a']);
    const full = Array.from({ length: MAX_QUERIES }, (_, i) => `q${i}`);
    expect(saveQuery(full, 'new')).toBeNull();
    expect(saveQuery(full, 'q3')?.[0]).toBe('q3');
  });
});

describe('drive warning label', () => {
  it('is short', () => {
    const e: Entity = { entity_id: 'sensor.nas2_drive_1_temperature', state: '54', last_changed: '', attributes: { friendly_name: 'NAS2 (Drive 1) Temperature', unit_of_measurement: '°C' } };
    expect(warnings([e])[0].text).toBe('NAS2 Drive 1 · 54°C');
  });
});
