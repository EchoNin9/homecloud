/**
 * Sun and moon positions for the Sun & Moon card. Low-precision textbook formulas (the same ones
 * SunCalc uses): good to a fraction of a degree and a few minutes on rise/set, plenty for a chart.
 * ponytail: no parallax or topocentric correction for the moon; use a real ephemeris if minutes matter.
 */
const RAD = Math.PI / 180;
const E = RAD * 23.4397; // obliquity of the ecliptic
const DAY_MS = 86_400_000;
const J2000_MS = Date.UTC(2000, 0, 1, 12); // epoch for `d`

const days = (ms: number) => (ms - J2000_MS) / DAY_MS;
const raOf = (l: number, b: number) => Math.atan2(Math.sin(l) * Math.cos(E) - Math.tan(b) * Math.sin(E), Math.cos(l));
const decOf = (l: number, b: number) => Math.asin(Math.sin(b) * Math.cos(E) + Math.cos(b) * Math.sin(E) * Math.sin(l));

function sunCoords(d: number) {
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  return { ra: raOf(L, 0), dec: decOf(L, 0) };
}

function moonCoords(d: number) {
  const L = RAD * (218.316 + 13.176396 * d);
  const M = RAD * (134.963 + 13.064993 * d);
  const F = RAD * (93.272 + 13.22935 * d);
  const l = L + RAD * 6.289 * Math.sin(M);
  const b = RAD * 5.128 * Math.sin(F);
  return { ra: raOf(l, b), dec: decOf(l, b), dist: 385001 - 20905 * Math.cos(M) };
}

/** Degrees above the horizon of a body at (ra, dec), seen from lat/lon at day `d`. */
function altitude(d: number, ra: number, dec: number, lat: number, lon: number) {
  const H = RAD * (280.16 + 360.9856235 * d) + RAD * lon - ra;
  const phi = RAD * lat;
  return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)) / RAD;
}

export const sunAltitude = (ms: number, lat: number, lon: number) => {
  const d = days(ms);
  const s = sunCoords(d);
  return altitude(d, s.ra, s.dec, lat, lon);
};

export const moonAltitude = (ms: number, lat: number, lon: number) => {
  const d = days(ms);
  const m = moonCoords(d);
  return altitude(d, m.ra, m.dec, lat, lon);
};

/** Moon phase (0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter) and lit fraction (0..1). */
export function moonPhase(ms: number): { phase: number; lit: number } {
  const d = days(ms);
  const s = sunCoords(d);
  const m = moonCoords(d);
  const sdist = 149_598_000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(
    Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra),
  );
  return { phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI, lit: (1 + Math.cos(inc)) / 2 };
}

const PHASES = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
/** Phase name; the four principal phases get a window of ±1/16 of a cycle (about ±1.8 days). */
export const phaseName = (phase: number) => PHASES[Math.floor((((phase % 1) + 1) % 1) * 8 + 0.5) % 8]!;

export interface Curve {
  /** [epoch ms, degrees] every `stepMs`, from `from` to `to` inclusive. */
  pts: Array<[number, number]>;
  /** Times it crosses the horizon going up / down within the window. */
  rises: number[];
  sets: number[];
}

/**
 * Sample an altitude function over [from, to] and find horizon crossings (linear interpolation).
 * `horizon`: -0.833° for the sun's upper limb with refraction, ~0.13° for the moon.
 */
export function curve(alt: (ms: number) => number, from: number, to: number, horizon: number, stepMs = 5 * 60_000): Curve {
  const pts: Array<[number, number]> = [];
  for (let t = from; t <= to; t += stepMs) pts.push([t, alt(t)]);
  const rises: number[] = [];
  const sets: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const [t0, a0] = pts[i - 1]!;
    const [t1, a1] = pts[i]!;
    if ((a0 - horizon) * (a1 - horizon) >= 0 || a0 === a1) continue;
    const t = t0 + ((horizon - a0) / (a1 - a0)) * (t1 - t0);
    (a1 > a0 ? rises : sets).push(Math.round(t));
  }
  return { pts, rises, sets };
}

export const SUN_HORIZON = -0.833;
export const MOON_HORIZON = 0.133;
