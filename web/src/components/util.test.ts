import { describe, expect, it } from 'vitest';
import type { Entity } from '../client';
import { DEFAULT_PREFS, organize, prettyState, sunTimes, warnings } from './util';

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
    ], now);
    expect(w.map((x) => [x.kind, x.entity.entity_id])).toEqual([
      ['door', 'binary_sensor.old'],
      ['drive', 'sensor.nas_drive_1_temperature'],
      ['drive', 'sensor.nas_drive_3_temperature'],
    ]);
  });
});

describe('sunTimes', () => {
  it('formats next rising/setting as 24h local time', () => {
    const sun: Entity = {
      entity_id: 'sun.sun', state: 'above_horizon', last_changed: '',
      attributes: { next_rising: '2026-10-22T11:28:00+00:00', next_setting: '2026-10-22T22:15:00+00:00' },
    };
    expect(sunTimes([sun], 'America/Toronto')).toEqual({ rise: '07:28', set: '18:15' });
    expect(sunTimes([])).toEqual({ rise: undefined, set: undefined });
  });
});

describe('prettyState', () => {
  it('humanizes words, leaves numbers', () => {
    expect(prettyState('above_horizon')).toBe('Above horizon');
    expect(prettyState('12.4')).toBe('12.4');
    expect(prettyState('-3')).toBe('-3');
  });
});
