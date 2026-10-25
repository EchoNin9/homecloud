import { describe, expect, it } from 'vitest';
import type { History } from '../client';
import { historyModel, isTracked } from './history';

const T0 = Date.parse('2026-10-24T00:00:00Z');
const H = 3_600_000;
const raw = (points: History['points'], prev: History['prev'] = null): History =>
  ({ entityId: 'x.y', res: 'raw', from: T0, to: T0 + 24 * H, prev, points }) as History;

describe('historyModel', () => {
  it('never throws on no data: first deploy, untracked, junk', () => {
    expect(historyModel(null).kind).toBe('empty');
    expect(historyModel(raw([])).kind).toBe('empty');
    expect(historyModel({ ...raw([]), points: undefined } as unknown as History).kind).toBe('empty');
    expect(historyModel(raw([{ t: 'not a date', state: 'on' }])).kind).toBe('empty');
    expect(historyModel({ entityId: 'x.y', res: 'day', from: 0, to: 1, prev: null, points: [] }).kind).toBe('empty');
    expect(historyModel({ entityId: 'x.y', res: 'day', from: 0, to: 1, prev: null, points: [{ date: '2026-10-01', n: 0 }] }).kind).toBe('empty');
  });

  it('a quiet raw window falls back to the current state, if it predates the window end', () => {
    const cur = { t: '2026-10-20T00:00:00Z', state: '38' };
    expect(historyModel(raw([]), T0 + 24 * H, cur)).toMatchObject({ kind: 'line', pts: [{ t: T0, v: 38 }] });
    expect(historyModel(raw([]), T0 + 24 * H, { t: '2026-10-26T00:00:00Z', state: '38' }).kind).toBe('empty');
    expect(historyModel(raw([]), T0 + 24 * H, { t: 'garbage', state: '38' }).kind).toBe('empty');
  });

  it('numeric raw becomes a step line that starts at the window edge', () => {
    const m = historyModel(raw([{ t: '2026-10-24T06:00:00Z', state: '41' }], { t: '2026-10-23T20:00:00Z', state: '39' }), T0 + 24 * H);
    expect(m).toMatchObject({ kind: 'line', min: 39, max: 41, pts: [{ t: T0, v: 39 }, { t: T0 + 6 * H, v: 41 }] });
  });

  it('on/off raw becomes a timeline clipped to now', () => {
    const m = historyModel(raw([{ t: '2026-10-24T06:00:00Z', state: 'on' }, { t: '2026-10-24T12:00:00Z', state: 'off' }]), T0 + 18 * H);
    expect(m).toMatchObject({ kind: 'timeline', active: 'on', segs: [{ a: T0 + 6 * H, b: T0 + 12 * H, state: 'on' }, { a: T0 + 12 * H, b: T0 + 18 * H, state: 'off' }] });
  });

  it('daily rollups become a band (numeric) or active-hours bars', () => {
    const day = (points: History['points']) => historyModel({ entityId: 'x.y', res: 'day', from: 0, to: 1, prev: null, points });
    expect(day([{ date: '2026-10-01', min: 30, max: 50, avg: 41, n: 9 }])).toMatchObject({ kind: 'band', min: 30, max: 50 });
    expect(day([{ date: '2026-10-01', dur: { below_horizon: 50400, above_horizon: 36000 }, n: 2 }])).toMatchObject({
      kind: 'bars', state: 'above_horizon', days: [{ date: '2026-10-01', hours: 10 }],
    });
  });
});

describe('isTracked', () => {
  it('matches history_entities globs literally apart from *', () => {
    const g = ['sensor.*_drive_*_temperature', 'sun.sun'];
    expect(isTracked('sensor.nas2_drive_3_temperature', g)).toBe(true);
    expect(isTracked('sun.sun', g)).toBe(true);
    expect(isTracked('sunxsun', g)).toBe(false);
    expect(isTracked('sun.sun', undefined)).toBe(false);
  });
});
