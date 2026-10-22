import { useEffect, useId, useRef, useState } from 'react';
import type { Entity } from '../client';
import { domainOf, friendlyName } from './util';

export interface Action {
  service: string;
  data?: Record<string, unknown>;
  /** Optimistic overlay applied until the command settles. */
  patch?: { state?: string; attributes?: Record<string, unknown> };
  /** Human description used in error toasts, e.g. "turn on". */
  label: string;
}

interface Props {
  entity: Entity;
  disabled: boolean;
  busy: boolean;
  onAction: (entity: Entity, action: Action) => void;
  fav?: boolean;
  hidden?: boolean;
  onToggleFav?: () => void;
  onToggleHidden?: () => void;
}

/** Debounced value commit: returns [draft, setDraft]; calls commit(draft) 400ms after last change. */
function useDraft<T>(commit: (v: T) => void, delay = 400) {
  const [draft, setDraft] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => clearTimeout(timer.current), []);
  const set = (v: T) => {
    setDraft(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      commitRef.current(v);
      setDraft(null);
    }, delay);
  };
  return [draft, set] as const;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function Switch({ checked, labelledBy, disabled, onChange }: { checked: boolean; labelledBy: string; disabled: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      className="hc-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="hc-switch-knob" aria-hidden="true" />
    </button>
  );
}

function Brightness({ entity, name, disabled, onAction }: { entity: Entity; name: string; disabled: boolean; onAction: Props['onAction'] }) {
  const raw = num(entity.attributes.brightness) ?? 0;
  const pct = Math.round((raw / 255) * 100);
  const [draft, setDraft] = useDraft<number>((v) =>
    onAction(entity, {
      service: 'turn_on',
      data: { brightness: Math.round((v / 100) * 255) },
      patch: { state: 'on', attributes: { brightness: Math.round((v / 100) * 255) } },
      label: 'set brightness',
    }),
  );
  const shown = draft ?? pct;
  return (
    <div className="hc-row">
      <input
        type="range"
        className="hc-range"
        min={1}
        max={100}
        value={Math.max(1, shown)}
        disabled={disabled}
        aria-label={`${name} brightness`}
        aria-valuetext={`${shown}%`}
        onChange={(ev) => setDraft(Number(ev.target.value))}
      />
      <span className="hc-value" aria-hidden="true">{shown}%</span>
    </div>
  );
}

function Climate({ entity, name, disabled, onAction }: { entity: Entity; name: string; disabled: boolean; onAction: Props['onAction'] }) {
  const a = entity.attributes;
  const target = num(a.temperature);
  const current = num(a.current_temperature);
  const unit = String(a.temperature_unit ?? a.unit_of_measurement ?? '°');
  const step = num(a.target_temp_step) ?? (unit.includes('F') ? 1 : 0.5);
  const min = num(a.min_temp);
  const max = num(a.max_temp);
  const [draft, setDraft] = useDraft<number>((v) =>
    onAction(entity, { service: 'set_temperature', data: { temperature: v }, patch: { attributes: { temperature: v } }, label: 'set temperature' }),
  700);
  const shown = draft ?? target;
  const bump = (d: number) => {
    if (shown === undefined) return;
    let next = Math.round((shown + d * step) / step) * step;
    next = Math.round(next * 100) / 100;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    setDraft(next);
  };
  return (
    <div>
      <div className="hc-stepper" role="group" aria-label={`${name} target temperature`}>
        <button type="button" className="hc-btn hc-btn-icon" aria-label="Decrease target temperature" disabled={disabled || shown === undefined} onClick={() => bump(-1)}>−</button>
        <output className="hc-temp" aria-live="polite">{shown === undefined ? '—' : `${shown}${unit}`}</output>
        <button type="button" className="hc-btn hc-btn-icon" aria-label="Increase target temperature" disabled={disabled || shown === undefined} onClick={() => bump(1)}>+</button>
      </div>
      <p className="hc-meta">
        {current !== undefined && <>Now {current}{unit}</>}
        {typeof a.hvac_action === 'string' && <> · {a.hvac_action}</>}
        {current === undefined && typeof a.hvac_action !== 'string' && <>Mode: {entity.state}</>}
      </p>
    </div>
  );
}

const BINARY_WORDS: Record<string, [string, string]> = {
  motion: ['Detected', 'Clear'],
  door: ['Open', 'Closed'],
  window: ['Open', 'Closed'],
  opening: ['Open', 'Closed'],
  occupancy: ['Occupied', 'Clear'],
  moisture: ['Wet', 'Dry'],
  smoke: ['Smoke', 'Clear'],
};

export function EntityCard({ entity, disabled, busy, onAction, fav, hidden, onToggleFav, onToggleHidden }: Props) {
  const nameId = useId();
  const domain = domainOf(entity.entity_id);
  const name = friendlyName(entity);
  const off = disabled || undefined;
  const isOn = entity.state === 'on';

  let control: JSX.Element;
  let status: string | null = null;

  switch (domain) {
    case 'light':
    case 'switch':
    case 'fan': {
      status = entity.state;
      const modes = entity.attributes.supported_color_modes;
      const hasBrightness =
        domain === 'light' &&
        (num(entity.attributes.brightness) !== undefined ||
          (Array.isArray(modes) && modes.some((m) => m !== 'onoff')));
      control = (
        <>
          <Switch
            checked={isOn}
            labelledBy={nameId}
            disabled={!!off}
            onChange={(next) =>
              onAction(entity, {
                service: next ? 'turn_on' : 'turn_off',
                patch: { state: next ? 'on' : 'off' },
                label: next ? 'turn on' : 'turn off',
              })
            }
          />
          {hasBrightness && <Brightness entity={entity} name={name} disabled={!!off} onAction={onAction} />}
        </>
      );
      break;
    }
    case 'climate':
      status = entity.state;
      control = <Climate entity={entity} name={name} disabled={!!off} onAction={onAction} />;
      break;
    case 'cover':
      status = entity.state;
      control = (
        <div className="hc-actions">
          <button type="button" className="hc-btn" disabled={!!off || entity.state === 'open'} onClick={() => onAction(entity, { service: 'open_cover', patch: { state: 'open' }, label: 'open' })}>
            Open<span className="hc-sr"> {name}</span>
          </button>
          <button type="button" className="hc-btn" disabled={!!off || entity.state === 'closed'} onClick={() => onAction(entity, { service: 'close_cover', patch: { state: 'closed' }, label: 'close' })}>
            Close<span className="hc-sr"> {name}</span>
          </button>
        </div>
      );
      break;
    case 'scene':
      control = (
        <button type="button" className="hc-btn hc-btn-primary" disabled={!!off || busy} onClick={() => onAction(entity, { service: 'turn_on', label: 'activate' })}>
          Activate<span className="hc-sr"> {name}</span>
        </button>
      );
      break;
    case 'sensor': {
      const unit = entity.attributes.unit_of_measurement;
      control = (
        <p className="hc-reading">
          {entity.state}
          {typeof unit === 'string' && unit && <span className="hc-unit"> {unit}</span>}
        </p>
      );
      break;
    }
    case 'binary_sensor': {
      const words = BINARY_WORDS[String(entity.attributes.device_class)] ?? ['On', 'Off'];
      control = <p className="hc-reading">{entity.state === 'on' ? words[0] : entity.state === 'off' ? words[1] : entity.state}</p>;
      break;
    }
    default:
      control = <p className="hc-reading">{entity.state}</p>;
  }

  return (
    <li className="hc-card" data-domain={domain} data-on={isOn || undefined} data-hidden={hidden || undefined} aria-busy={busy || undefined}>
      <div className="hc-card-head">
        <div className="hc-card-title">
          <span id={nameId} className="hc-name">{name}</span>
          <span className="hc-id">{entity.entity_id}</span>
        </div>
        {status && domain !== 'light' && domain !== 'switch' && domain !== 'fan' ? <span className="hc-pill">{status}</span> : null}
        {busy && <span className="hc-spinner" role="img" aria-label="Sending command" />}
        {onToggleFav && (
          <button type="button" className="hc-icon-btn" aria-pressed={!!fav} aria-label={`Favourite ${name}`} title={fav ? 'Unfavourite' : 'Favourite'} onClick={onToggleFav}>
            {fav ? '★' : '☆'}
          </button>
        )}
        {onToggleHidden && (
          <button type="button" className="hc-icon-btn hc-text-btn" aria-pressed={!!hidden} aria-label={`Hide ${name}`} title={hidden ? 'Unhide' : 'Hide'} onClick={onToggleHidden}>
            {hidden ? 'Unhide' : 'Hide'}
          </button>
        )}
      </div>
      <div className="hc-card-body">{control}</div>
    </li>
  );
}
