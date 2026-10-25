// Light colour helpers. No imports, so the dev mock (web/mock) can use them too.

export type Rgb = [number, number, number];

const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));

export const toHex = (c: Rgb): string => '#' + c.map((v) => clamp(v).toString(16).padStart(2, '0')).join('');

export const fromHex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) || 0) as Rgb;

/** `rgb_color` attribute as a tuple, or undefined when absent or malformed. */
export function rgbOf(attrs: Record<string, unknown>): Rgb | undefined {
  const c = attrs.rgb_color;
  return Array.isArray(c) && c.length === 3 && c.every((v) => typeof v === 'number' && Number.isFinite(v)) ? (c as Rgb) : undefined;
}

/** Approximate RGB of a white point. Tanner Helland's curve fit; good enough for previews and tints. */
export function kelvinToRgb(kelvin: number): Rgb {
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [clamp(r), clamp(g), clamp(b)];
}
