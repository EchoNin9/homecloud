import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Entity, History, HomeCloudClient } from '../client';
import { DAY_MS as DAY, RANGES, historyModel, isActive, type Model, type Range } from './history';
import { domainOf, errorMessage, friendlyName } from './util';

/** Domains whose "on" is amber on tiles; their charts match. */
const AMBER = new Set(['light', 'switch', 'fan', 'sun']);

const H = 180;
const PAD = { l: 56, r: 8, t: 8, b: 22 };
const PH = H - PAD.t - PAD.b;

/** Chart width in CSS px, so text stays 11px on phones instead of scaling down with the SVG. */
export function useWidth(fallback = 600) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const fmtTime = (t: number, long: boolean) =>
  new Date(t).toLocaleString(undefined, long ? { year: 'numeric', month: 'short', day: 'numeric' } : { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtNum = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : String(Math.round(v * 10) / 10));

interface Props {
  client: HomeCloudClient;
  homeId: string;
  entity: Entity;
}

/** History of one entity: 24 h / 7 d from raw changes, 30 d / 15 mo from daily rollups. */
export function HistoryPanel({ client, homeId, entity }: Props) {
  const [range, setRange] = useState<Range>('24h');
  const [data, setData] = useState<{ range: Range; h: History } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const { res, ms } = RANGES[range];
    const to = Date.now();
    setErr(null);
    client.getHistory(homeId, entity.entity_id, { res, from: to - ms, to }).then(
      (h) => live && setData({ range, h }),
      (e) => live && setErr(errorMessage(e)),
    );
    return () => { live = false; };
  }, [client, homeId, entity.entity_id, range]);

  const loading = !err && data?.range !== range;
  const model = loading || err ? null : historyModel(data?.h, Date.now(), { t: entity.last_changed, state: entity.state });
  const unit = typeof entity.attributes.unit_of_measurement === 'string' ? entity.attributes.unit_of_measurement : '';
  const name = friendlyName(entity);

  return (
    <section className="hc-history" data-tone={AMBER.has(domainOf(entity.entity_id)) ? 'on' : undefined} aria-labelledby="hc-hist-title">
      <div className="hc-history-head">
        <h3 id="hc-hist-title">History</h3>
        <div className="hc-seg" role="group" aria-label="Range">
          {(Object.keys(RANGES) as Range[]).map((r) => (
            <button key={r} type="button" aria-pressed={r === range} onClick={() => setRange(r)}>{RANGES[r].label}</button>
          ))}
        </div>
      </div>
      <div className="hc-chart-wrap" aria-busy={loading || undefined}>
        {err ? <p className="hc-muted">Couldn't load history: {err}</p>
          : loading ? <p className="hc-muted">Loading…</p>
          : model && model.kind !== 'empty' ? <Chart model={model} unit={unit} long={RANGES[range].res === 'day'} name={name} />
          : <p className="hc-muted">{RANGES[range].res === 'day'
              ? 'No daily summaries yet. They are built nightly, just after midnight, from recorded changes, so the first appears the day after history starts.'
              : 'No history yet. Changes are recorded from when history was first deployed; this entity hasn\'t changed since.'}</p>}
      </div>
    </section>
  );
}

function Chart({ model, unit, long, name }: { model: Exclude<Model, { kind: 'empty' }>; unit: string; long: boolean; name: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [wrap, W] = useWidth();
  const padL = model.kind === 'timeline' ? PAD.r : PAD.l; // no value axis on timelines
  const PW = W - padL - PAD.r;
  const daily = model.kind === 'band' || model.kind === 'bars';
  const x0 = daily ? model.days[0]!.t - DAY / 2 : model.from;
  const x1 = daily ? model.days[model.days.length - 1]!.t + DAY / 2 : model.to;
  const x = (t: number) => padL + ((t - x0) / Math.max(1, x1 - x0)) * PW;
  let [lo, hi] = model.kind === 'bars' ? [0, 24] : model.kind === 'timeline' ? [0, 1] : [model.min, model.max];
  if (hi - lo < 1e-9) [lo, hi] = [lo - 1, hi + 1];
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * PH;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(x0 + (((e.clientX - r.left) / r.width) * W - padL) / PW * (x1 - x0));
  };
  // Raw charts: the part of the window before the first recorded state is "no data", not "off".
  const dataFrom = model.kind === 'line' ? model.pts[0]!.t : model.kind === 'timeline' ? model.segs[0]!.a : x0;
  const noData = dataFrom - x0 > (x1 - x0) * 0.01;
  const tip = hover === null ? null : hover < dataFrom ? 'No data yet' : tooltip(model, hover, unit, long);

  return (
    <>
      <div className="hc-chart" ref={wrap}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${name} history chart`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {model.kind !== 'timeline' && [lo, (lo + hi) / 2, hi].map((v) => (
            <g key={v}>
              <line x1={padL} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="hc-gridline" />
              <text x={padL - 6} y={y(v) + 4} textAnchor="end" className="hc-axis">{fmtNum(v)}{model.kind === 'bars' ? ' h' : v === hi && unit ? ` ${unit}` : ''}</text>
            </g>
          ))}
          {noData && (
            <g>
              <rect x={x(x0)} width={x(dataFrom) - x(x0)} y={PAD.t} height={PH} className="hc-nodata" />
              {x(dataFrom) - x(x0) > 90 && <text x={(x(x0) + x(dataFrom)) / 2} y={PAD.t + PH / 2 + 4} textAnchor="middle" className="hc-axis">No data yet</text>}
            </g>
          )}
          <text x={padL} y={H - 6} className="hc-axis">{fmtTime(daily ? model.days[0]!.t : x0, long)}</text>
          <text x={W - PAD.r} y={H - 6} textAnchor="end" className="hc-axis">{fmtTime(daily ? model.days[model.days.length - 1]!.t : x1, long)}</text>

          {model.kind === 'line' && (
            <path className="hc-line" d={model.pts.map((p, i) => (i ? `H${x(p.t)}V${y(p.v)}` : `M${x(p.t)},${y(p.v)}`)).join('') + `H${x(model.to)}`} />
          )}
          {model.kind === 'timeline' && model.segs.map((s, i) => (
            <rect key={i} x={x(s.a)} width={Math.max(1, x(s.b) - x(s.a) - 1)} y={PAD.t + PH / 4} height={PH / 2} rx={2}
              className={isActive(s.state) ? 'hc-seg-on' : 'hc-seg-off'} />
          ))}
          {model.kind === 'band' && (
            <>
              <path className="hc-band" d={`M${model.days.map((d) => `${x(d.t)},${y(d.max)}`).join('L')}L${[...model.days].reverse().map((d) => `${x(d.t)},${y(d.min)}`).join('L')}Z`} />
              <path className="hc-line" d={`M${model.days.map((d) => `${x(d.t)},${y(d.avg)}`).join('L')}`} />
            </>
          )}
          {model.kind === 'bars' && model.days.map((d) => {
            const bw = Math.max(1, PW / model.days.length - 2);
            const top = y(d.hours);
            const r = Math.min(4, bw / 2, y(0) - top);
            const l = x(d.t) - bw / 2;
            return <path key={d.date} className="hc-bar" d={`M${l},${y(0)}V${top + r}Q${l},${top} ${l + r},${top}H${l + bw - r}Q${l + bw},${top} ${l + bw},${top + r}V${y(0)}Z`} />;
          })}
          {hover !== null && hover >= x0 && hover <= x1 && <line className="hc-crosshair" x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + PH} />}
        </svg>
        {tip && hover !== null && hover >= x0 && hover <= x1 && (
          <div className="hc-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>{tip}</div>
        )}
      </div>
      {model.kind === 'timeline' && (
        <p className="hc-legend"><span className="hc-swatch hc-seg-on" /> {model.active ?? 'on'} <span className="hc-swatch hc-seg-off" /> other</p>
      )}
      {model.kind === 'band' && <p className="hc-legend"><span className="hc-swatch hc-line-sw" /> daily average · shaded: min–max</p>}
      {model.kind === 'bars' && <p className="hc-legend">Hours per day {model.state.replace(/_/g, ' ')}</p>}
      <details className="hc-table">
        <summary>Table</summary>
        <table>
          <tbody>{rows(model, unit).map(([a, b], i) => <tr key={i}><td>{a}</td><td>{b}</td></tr>)}</tbody>
        </table>
      </details>
    </>
  );
}

function tooltip(m: Exclude<Model, { kind: 'empty' }>, t: number, unit: string, long: boolean): string | null {
  const at = (ts: number) => fmtTime(ts, long) + (long ? ` ${fmtTime(ts, false)}` : '');
  if (m.kind === 'line') {
    const p = [...m.pts].reverse().find((q) => q.t <= t);
    return p ? `${at(t)} · ${fmtNum(p.v)}${unit}` : null;
  }
  if (m.kind === 'timeline') {
    const s = m.segs.find((q) => q.a <= t && t < q.b);
    return s ? `${s.state.replace(/_/g, ' ')} · ${at(s.a)}–${at(s.b)}` : null;
  }
  const near = <D extends { t: number }>(days: D[]) => days.reduce((b, q) => (Math.abs(q.t - t) < Math.abs(b.t - t) ? q : b));
  if (m.kind === 'band') {
    const d = near(m.days);
    return `${d.date} · avg ${fmtNum(d.avg)}${unit} (${fmtNum(d.min)}–${fmtNum(d.max)})`;
  }
  const d = near(m.days);
  return `${d.date} · ${fmtNum(d.hours)} h`;
}

function rows(m: Exclude<Model, { kind: 'empty' }>, unit: string): [string, string][] {
  const at = (ts: number) => fmtTime(ts, true) + ' ' + fmtTime(ts, false);
  if (m.kind === 'line') return m.pts.map((p) => [at(p.t), `${fmtNum(p.v)}${unit}`]);
  if (m.kind === 'timeline') return m.segs.map((s) => [at(s.a), s.state]);
  if (m.kind === 'band') return m.days.map((d) => [d.date, `avg ${fmtNum(d.avg)}${unit}, ${fmtNum(d.min)}–${fmtNum(d.max)}`]);
  return m.days.map((d) => [d.date, `${fmtNum(d.hours)} h`]);
}
