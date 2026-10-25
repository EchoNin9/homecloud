import { useEffect, useId, useRef, useState } from 'react';
import type { Entity } from '../client';
import { Icon, entityIcon, iconTone } from './icons';
import { domainOf, friendlyName, stateText } from './util';

export interface Action {
  service: string;
  data?: Record<string, unknown>;
  /** Optimistic overlay applied until the command settles. */
  patch?: { state?: string; attributes?: Record<string, unknown> };
  /** Human description used in error toasts, e.g. "turn on". */
  label: string;
}

export type OnAction = (entity: Entity, action: Action) => void;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** What tapping the tile's icon does (HA's tile "icon tap action"), or null when it only shows state. */
export function primaryAction(e: Entity): Action | null {
  const d = domainOf(e.entity_id);
  const on = e.state === 'on';
  if (d === 'light' || d === 'switch' || d === 'fan') {
    return { service: on ? 'turn_off' : 'turn_on', patch: { state: on ? 'off' : 'on' }, label: on ? 'turn off' : 'turn on' };
  }
  if (d === 'scene') return { service: 'turn_on', label: 'activate' };
  if (d === 'cover') {
    return e.state === 'closed'
      ? { service: 'open_cover', patch: { state: 'open' }, label: 'open' }
      : { service: 'close_cover', patch: { state: 'closed' }, label: 'close' };
  }
  return null;
}

export const hasBrightness = (e: Entity) => {
  const modes = e.attributes.supported_color_modes;
  return domainOf(e.entity_id) === 'light' && (num(e.attributes.brightness) !== undefined || (Array.isArray(modes) && modes.some((m) => m !== 'onoff')));
};

/** Debounced value commit: returns [draft, setDraft]; calls commit(draft) `delay` ms after the last change. */
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

export function Switch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled: boolean; onChange: (next: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="hc-switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="hc-switch-knob" aria-hidden="true" />
    </button>
  );
}

export function Brightness({ entity, disabled, onAction }: { entity: Entity; disabled: boolean; onAction: OnAction }) {
  const pct = Math.round(((num(entity.attributes.brightness) ?? 0) / 255) * 100);
  const [draft, setDraft] = useDraft<number>((v) =>
    onAction(entity, {
      service: 'turn_on',
      data: { brightness: Math.round((v / 100) * 255) },
      patch: { state: 'on', attributes: { brightness: Math.round((v / 100) * 255) } },
      label: 'set brightness',
    }),
  );
  const shown = draft ?? (entity.state === 'on' ? pct : 0);
  return (
    <input
      type="range"
      className="hc-range"
      style={{ '--hc-fill': `${shown}%` } as React.CSSProperties}
      min={1}
      max={100}
      value={Math.max(1, shown)}
      disabled={disabled}
      aria-label={`${friendlyName(entity)} brightness`}
      aria-valuetext={`${shown}%`}
      onChange={(ev) => setDraft(Number(ev.target.value))}
    />
  );
}

export function Climate({ entity, disabled, onAction }: { entity: Entity; disabled: boolean; onAction: OnAction }) {
  const a = entity.attributes;
  const target = num(a.temperature);
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
    <div className="hc-stepper" role="group" aria-label={`${friendlyName(entity)} target temperature`}>
      <button type="button" className="hc-btn hc-step" aria-label="Decrease target temperature" disabled={disabled || shown === undefined} onClick={() => bump(-1)}>−</button>
      <output className="hc-temp" aria-live="polite">{shown === undefined ? '—' : `${shown} ${unit}`}</output>
      <button type="button" className="hc-btn hc-step" aria-label="Increase target temperature" disabled={disabled || shown === undefined} onClick={() => bump(1)}>+</button>
    </div>
  );
}

interface TileProps {
  entity: Entity;
  disabled: boolean;
  busy: boolean;
  onAction: OnAction;
  /** Opens the more-info dialog. */
  onOpen: () => void;
  hidden?: boolean;
  selecting?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}

/**
 * Home Assistant style tile: icon (tap = toggle/activate), name and state (tap = more info),
 * plus a feature row for lights with brightness and for climate.
 */
export function EntityCard({ entity, disabled, busy, onAction, onOpen, hidden, selecting, selected, onSelect }: TileProps) {
  const nameId = useId();
  const name = friendlyName(entity);
  const act = selecting ? null : primaryAction(entity);
  const tone = iconTone(entity);
  const d = domainOf(entity.entity_id);
  const icon = (
    <span className="hc-tile-icon" data-tone={tone || undefined} data-busy={busy || undefined}>
      <Icon path={entityIcon(entity)} />
    </span>
  );
  return (
    <li
      id={`hc-e-${entity.entity_id}`}
      className="hc-tile"
      data-tone={tone || undefined}
      data-hidden={hidden || undefined}
      data-selected={selected || undefined}
      aria-busy={busy || undefined}
    >
      <div className="hc-tile-main">
        {act ? (
          <button
            type="button"
            className="hc-tile-act"
            {...(act.patch ? { role: 'switch', 'aria-checked': entity.state === 'on' || (d === 'cover' && entity.state !== 'closed') } : {})}
            aria-label={act.patch ? `${name}` : `Activate ${name}`}
            aria-describedby={nameId}
            disabled={disabled || (busy && d === 'scene')}
            onClick={() => onAction(entity, act)}
          >
            {icon}
          </button>
        ) : (
          icon
        )}
        <button type="button" className="hc-tile-info" aria-haspopup={selecting ? undefined : 'dialog'} aria-pressed={selecting ? !!selected : undefined} onClick={selecting ? onSelect : onOpen}>
          <span className="hc-tile-name" title={name}>{name}</span>
          <span className="hc-tile-state" id={nameId}>{stateText(entity)}</span>
        </button>
        {selecting && <span className="hc-tile-check" aria-hidden="true">{selected ? '✓' : ''}</span>}
      </div>
      {!selecting && hasBrightness(entity) && (
        <div className="hc-tile-feature"><Brightness entity={entity} disabled={disabled} onAction={onAction} /></div>
      )}
      {!selecting && d === 'climate' && (
        <div className="hc-tile-feature"><Climate entity={entity} disabled={disabled} onAction={onAction} /></div>
      )}
    </li>
  );
}
