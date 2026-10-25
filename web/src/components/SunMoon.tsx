import {
  mdiMoonFirstQuarter, mdiMoonFull, mdiMoonLastQuarter, mdiMoonNew, mdiMoonWaningCrescent, mdiMoonWaningGibbous,
  mdiMoonWaxingCrescent, mdiMoonWaxingGibbous, mdiWhiteBalanceSunny,
} from '@mdi/js';
import { useEffect, useMemo, useState, type PointerEvent } from 'react';
import type { Entity } from '../client';
import { MOON_HORIZON, SUN_HORIZON, curve, moonAltitude, moonPhase, phaseName, sunAltitude } from './astro';
import { useWidth } from './HistoryPanel';
import { Icon } from './icons';

const MOON_ICONS = [mdiMoonNew, mdiMoonWaxingCrescent, mdiMoonFirstQuarter, mdiMoonWaxingGibbous, mdiMoonFull, mdiMoonWaningGibbous, mdiMoonLastQuarter, mdiMoonWaningCrescent];
export const moonIcon = (phase: number) => MOON_ICONS[Math.floor((((phase % 1) + 1) % 1) * 8 + 0.5) % 8]!;

type Show = 'sun' | 'moon' | 'both';
const H = 200;
const PAD = { l: 36, r: 8, t: 10, b: 22 };
const LO = -30;
const HI = 90;
const hhmm = (t: number) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
const deg = (a: number) => `${Math.round(a)}°`;

/** Home location the bridge adds to sun.sun, or null. */
export function homeLocation(sun: Entity | undefined): [number, number] | null {
  const a = sun?.attributes;
  return typeof a?.homecloud_latitude === 'number' && typeof a.homecloud_longitude === 'number' ? [a.homecloud_latitude, a.homecloud_longitude] : null;
}

/** Today's sun and moon paths across the sky (viewer's local day), plus rise/set and the moon's phase. */
export function SunMoon({ sun }: { sun: Entity }) {
  const loc = homeLocation(sun);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const [show, setShow] = useState<Show>('both');
  const [wrap, W] = useWidth();
  const [hover, setHover] = useState<number | null>(null);

  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const from = day.getTime();
  const to = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime(); // 23/25 h on DST days

  const data = useMemo(() => {
    if (!loc) return null;
    const [lat, lon] = loc;
    return {
      sun: curve((t) => sunAltitude(t, lat, lon), from, to, SUN_HORIZON),
      moon: curve((t) => moonAltitude(t, lat, lon), from, to, MOON_HORIZON),
    };
  }, [loc?.[0], loc?.[1], from, to]);

  if (!loc || !data) {
    return <p className="hc-muted">The home's location isn't available yet, so sun and moon paths can't be drawn. The NAS bridge adds it to the Sun entity.</p>;
  }
  const [lat, lon] = loc;
  const m = moonPhase(now);
  const sunNow = sunAltitude(now, lat, lon);
  const moonNow = moonAltitude(now, lat, lon);

  const PW = W - PAD.l - PAD.r;
  const PH = H - PAD.t - PAD.b;
  const x = (t: number) => PAD.l + ((t - from) / (to - from)) * PW;
  const y = (a: number) => PAD.t + (1 - (a - LO) / (HI - LO)) * PH; // below LO is clipped, not flattened
  const path = (pts: Array<[number, number]>) => pts.map(([t, a], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(a).toFixed(1)}`).join('');
  // Night = sun below the horizon: shade those stretches.
  const night: Array<[number, number]> = [];
  for (const [t, a] of data.sun.pts) {
    const last = night[night.length - 1];
    if (a < SUN_HORIZON) last && last[1] === t - 5 * 60_000 ? (last[1] = t) : night.push([t, t]);
  }
  const at = (c: typeof data.sun, t: number) => c.pts[Math.min(c.pts.length - 1, Math.max(0, Math.round((t - from) / (5 * 60_000))))]![1];
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = from + (((e.clientX - r.left) / r.width) * W - PAD.l) / PW * (to - from);
    setHover(t >= from && t <= to ? t : null);
  };
  const tip = hover === null ? null : [hhmm(hover), show !== 'moon' && `Sun ${deg(at(data.sun, hover))}`, show !== 'sun' && `Moon ${deg(at(data.moon, hover))}`].filter(Boolean).join(' · ');
  const times = (ts: number[]) => (ts.length ? ts.map(hhmm).join(', ') : '—');

  return (
    <section className="hc-sunmoon" aria-label="Sun and moon">
      <div className="hc-history-head">
        <h3>Sun &amp; moon today</h3>
        <div className="hc-seg" role="group" aria-label="Show">
          {(['sun', 'moon', 'both'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={show === k} onClick={() => setShow(k)}>{k === 'both' ? 'Both' : k === 'sun' ? 'Sun' : 'Moon'}</button>
          ))}
        </div>
      </div>
      <div className="hc-chart" ref={wrap}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Altitude of the sun and moon today, in degrees above the horizon" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {night.map(([a, b]) => <rect key={a} x={x(a)} width={Math.max(1, x(b) - x(a))} y={PAD.t} height={PH} className="hc-night" />)}
          {[0, 30, 60, 90].map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className={v === 0 ? 'hc-horizon' : 'hc-gridline'} />
              <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className="hc-axis">{v}°</text>
            </g>
          ))}
          {[0, 6, 12, 18, 24].map((h) => {
            const t = from + (h / 24) * (to - from);
            return <text key={h} x={x(t)} y={H - 6} textAnchor={h === 0 ? 'start' : h === 24 ? 'end' : 'middle'} className="hc-axis">{String(h).padStart(2, '0')}:00</text>;
          })}
          <clipPath id="hc-sky"><rect x={PAD.l} y={PAD.t - 6} width={PW} height={PH + 6} /></clipPath>
          <g clipPath="url(#hc-sky)">
            {show !== 'sun' && <path d={path(data.moon.pts)} className="hc-moon-line" />}
            {show !== 'moon' && <path d={path(data.sun.pts)} className="hc-sun-line" />}
            {show !== 'sun' && <circle cx={x(now)} cy={y(moonNow)} r={5} className="hc-moon-dot" />}
            {show !== 'moon' && <circle cx={x(now)} cy={y(sunNow)} r={5} className="hc-sun-dot" />}
          </g>
          <line x1={x(now)} x2={x(now)} y1={PAD.t} y2={PAD.t + PH} className="hc-crosshair" />
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + PH} className="hc-crosshair" />}
        </svg>
        {tip && hover !== null && <div className="hc-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>{tip}</div>}
      </div>
      <p className="hc-legend">
        {show !== 'moon' && <><span className="hc-swatch hc-sun-sw" /> Sun</>}
        {show !== 'sun' && <><span className="hc-swatch hc-moon-sw" /> Moon</>}
        <span className="hc-swatch hc-night-sw" /> Night · line at 0° is the horizon
      </p>
      <dl className="hc-astro">
        <div>
          <dt><Icon path={mdiWhiteBalanceSunny} size={20} /> Sun</dt>
          <dd>Rise {times(data.sun.rises)} · Set {times(data.sun.sets)} · Now {deg(sunNow)}</dd>
        </div>
        <div>
          <dt><Icon path={moonIcon(m.phase)} size={20} /> Moon</dt>
          <dd>Rise {times(data.moon.rises)} · Set {times(data.moon.sets)} · Now {deg(moonNow)} · {phaseName(m.phase)}, {Math.round(m.lit * 100)}% lit</dd>
        </div>
      </dl>
      <details className="hc-table">
        <summary>Table</summary>
        <table>
          <thead><tr><th>Time</th><th>Sun</th><th>Moon</th></tr></thead>
          <tbody>
            {data.sun.pts.filter((_, i) => i % 12 === 0).map(([t]) => (
              <tr key={t}><td>{hhmm(t)}</td><td>{deg(at(data.sun, t))}</td><td>{deg(at(data.moon, t))}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
