import { describe, expect, it } from 'vitest';
import { fromHex, kelvinToRgb, rgbOf, toHex } from './color';

describe('color', () => {
  it('round-trips hex', () => {
    expect(toHex([255, 128, 0])).toBe('#ff8000');
    expect(fromHex('#ff8000')).toEqual([255, 128, 0]);
    expect(toHex([300, -4, 12.6])).toBe('#ff000d');
  });
  it('reads rgb_color only when well formed', () => {
    expect(rgbOf({ rgb_color: [1, 2, 3] })).toEqual([1, 2, 3]);
    expect(rgbOf({ rgb_color: [1, 2] })).toBeUndefined();
    expect(rgbOf({ rgb_color: null })).toBeUndefined();
  });
  it('maps kelvin from warm to neutral white', () => {
    const warm = kelvinToRgb(2000);
    expect(warm[0]).toBe(255);
    expect(warm[2]).toBeLessThan(60);
    const white = kelvinToRgb(6600);
    expect(white.every((v) => v > 240)).toBe(true);
  });
});
