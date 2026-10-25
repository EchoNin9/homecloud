import { describe, expect, it } from 'vitest';
import { SUN_HORIZON, curve, moonPhase, phaseName, sunAltitude } from './astro';

const VAN = [49.28, -123.12] as const;

describe('astro', () => {
  it('moon phase matches 2026 eclipses (full at lunar, new at solar)', () => {
    const full = moonPhase(Date.UTC(2026, 2, 3, 11, 33));
    expect(full.lit).toBeGreaterThan(0.99);
    expect(phaseName(full.phase)).toBe('Full moon');
    for (const t of [Date.UTC(2026, 1, 17, 12, 1), Date.UTC(2026, 7, 12, 17, 46)]) {
      const m = moonPhase(t);
      expect(m.lit).toBeLessThan(0.01);
      expect(phaseName(m.phase)).toBe('New moon');
    }
  });

  it('sun: midsummer noon height and Vancouver rise/set on 2026-10-25', () => {
    const day = curve((t) => sunAltitude(t, ...VAN), Date.UTC(2026, 5, 21, 7), Date.UTC(2026, 5, 22, 7), SUN_HORIZON);
    expect(Math.max(...day.pts.map(([, a]) => a))).toBeCloseTo(90 - 49.28 + 23.44, 0);
    const oct = curve((t) => sunAltitude(t, ...VAN), Date.UTC(2026, 9, 25, 7), Date.UTC(2026, 9, 26, 7), SUN_HORIZON);
    const near = (t: number, h: number, m: number) => Math.abs(t - Date.UTC(2026, 9, 25, h, m)) / 60_000;
    expect(near(oct.rises[0]!, 14, 47)).toBeLessThan(4); // 07:47 PDT
    expect(near(oct.sets[0]!, 25, 5)).toBeLessThan(4); // 18:05 PDT
  });
});
