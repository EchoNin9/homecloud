import { mdiCheck, mdiClose, mdiContentCopy, mdiEyeOff, mdiEyeOutline, mdiStar, mdiStarOutline } from '@mdi/js';
import { useEffect, useRef, useState } from 'react';
import type { Entity, HomeCloudClient } from '../client';
import { Brightness, Climate, ColorTemp, LightColor, Switch, hasBrightness, hasColor, hasColorTemp, lightTint, primaryAction, type OnAction } from './EntityCard';
import { HistoryPanel } from './HistoryPanel';
import { SunMoon } from './SunMoon';
import { Icon, entityIcon, iconTone } from './icons';
import { areaOf, domainOf, formatLastSeen, friendlyName, stateText, updateInfo } from './util';

interface Props {
  client: HomeCloudClient;
  homeId: string;
  entity: Entity;
  disabled: boolean;
  busy: boolean;
  onAction: OnAction;
  /** Set when the entity has history (history_entities). */
  tracked: boolean;
  fav: boolean;
  hidden: boolean;
  onToggleFav: () => void;
  onToggleHidden: () => void;
  groupNames: string[];
  inGroups: string[];
  onToggleGroup: (name: string) => void;
  onClose: () => void;
}

/** HA-style "more info": the entity's controls, its history, and per-entity settings. */
export function MoreInfo(p: Props) {
  const { entity: e, disabled, busy, onAction } = p;
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    ref.current?.focus(); // focus the dialog, not the close button, so no focus ring flashes on open
  }, []);
  const name = friendlyName(e);
  const d = domainOf(e.entity_id);
  const area = areaOf(e);
  const changed = Date.parse(e.last_changed);
  const act = primaryAction(e);

  let control: React.ReactNode = <p className="hc-big-state">{stateText(e)}</p>;
  if (d === 'light' || d === 'switch' || d === 'fan') {
    control = (
      <>
        <div className="hc-mi-row">
          <span className="hc-big-state">{stateText(e)}</span>
          <Switch checked={e.state === 'on'} label={name} disabled={disabled} onChange={() => act && onAction(e, act)} />
        </div>
        {hasBrightness(e) && <Brightness entity={e} disabled={disabled} onAction={onAction} />}
        {(hasColorTemp(e) || hasColor(e)) && (
          <div className="hc-light-color">
            {hasColorTemp(e) && <ColorTemp entity={e} disabled={disabled} onAction={onAction} />}
            {hasColor(e) && <LightColor entity={e} disabled={disabled} onAction={onAction} />}
          </div>
        )}
      </>
    );
  } else if (d === 'climate') {
    control = (
      <>
        <p className="hc-big-state">{stateText(e)}</p>
        <Climate entity={e} disabled={disabled} onAction={onAction} />
      </>
    );
  } else if (d === 'cover') {
    control = (
      <div className="hc-mi-row">
        <span className="hc-big-state">{stateText(e)}</span>
        <span className="hc-actions">
          <button type="button" className="hc-btn" disabled={disabled || e.state === 'open'} onClick={() => onAction(e, { service: 'open_cover', patch: { state: 'open' }, label: 'open' })}>Open</button>
          <button type="button" className="hc-btn" disabled={disabled || e.state === 'closed'} onClick={() => onAction(e, { service: 'close_cover', patch: { state: 'closed' }, label: 'close' })}>Close</button>
        </span>
      </div>
    );
  } else if (d === 'scene') {
    control = (
      <div className="hc-mi-row">
        <span className="hc-big-state">{stateText(e)}</span>
        <button type="button" className="hc-btn hc-btn-primary" disabled={disabled || busy} onClick={() => act && onAction(e, act)}>Activate</button>
      </div>
    );
  } else if (d === 'update') {
    control = <UpdateBody entity={e} />;
  } else if (e.entity_id === 'sun.sun') {
    control = <SunMoon sun={e} />;
  }

  return (
    <dialog ref={ref} tabIndex={-1} className="hc-dialog hc-more-info" onClose={p.onClose} aria-labelledby="hc-mi-title">
      <header className="hc-mi-head">
        <span className="hc-tile-icon" data-tone={iconTone(e) || undefined} data-busy={busy || undefined} {...lightTint(e)}><Icon path={entityIcon(e)} /></span>
        <div className="hc-mi-title">
          <h2 id="hc-mi-title">{name}</h2>
          <p className="hc-muted">
            {area && <>{area} · </>}
            {Number.isFinite(changed) ? <>Changed <time dateTime={e.last_changed} title={new Date(changed).toLocaleString()}>{formatLastSeen(changed)}</time></> : null}
          </p>
        </div>
        <form method="dialog">
          <button className="hc-icon-btn" aria-label="Close"><Icon path={mdiClose} /></button>
        </form>
      </header>

      <div className="hc-mi-control">{control}</div>

      {p.tracked && <HistoryPanel client={p.client} homeId={p.homeId} entity={e} />}

      <footer className="hc-mi-foot">
        <button type="button" className="hc-chip-btn" aria-pressed={p.fav} onClick={p.onToggleFav}>
          <Icon path={p.fav ? mdiStar : mdiStarOutline} size={18} /> {p.fav ? 'Favourite' : 'Add to favourites'}
        </button>
        <button type="button" className="hc-chip-btn" aria-pressed={p.hidden} onClick={p.onToggleHidden}>
          <Icon path={p.hidden ? mdiEyeOff : mdiEyeOutline} size={18} /> {p.hidden ? 'Hidden' : 'Hide'}
        </button>
        <GroupMenu all={p.groupNames} mine={p.inGroups} onToggle={p.onToggleGroup} />
        <code className="hc-mi-id" title="Entity ID">{e.entity_id}</code>
      </footer>
    </dialog>
  );
}

function GroupMenu({ all, mine, onToggle }: { all: string[]; mine: string[]; onToggle: (g: string) => void }) {
  const [draft, setDraft] = useState('');
  return (
    <details className="hc-menu">
      <summary className="hc-chip-btn">Groups{mine.length ? ` · ${mine.length}` : ''}</summary>
      <div className="hc-menu-body">
        {all.map((g) => (
          <label key={g} className="hc-check">
            <input type="checkbox" checked={mine.includes(g)} onChange={() => onToggle(g)} /> {g}
          </label>
        ))}
        <form
          className="hc-row"
          onSubmit={(ev) => {
            ev.preventDefault();
            const g = draft.trim();
            if (g && !mine.includes(g)) onToggle(g);
            setDraft('');
          }}
        >
          <input className="hc-input" placeholder="New group" aria-label="New group name" maxLength={40} value={draft} onChange={(ev) => setDraft(ev.target.value)} />
          <button type="submit" className="hc-btn" disabled={!draft.trim()}>Add</button>
        </form>
      </div>
    </details>
  );
}

/** How to apply one available update. Notify only: the NAS is upgraded by hand, never from the cloud. */
export function UpdateBody({ entity }: { entity: Entity }) {
  const [copied, setCopied] = useState(false);
  const u = updateInfo(entity);
  const cmd = u.steps.join('\n');
  if (entity.state !== 'on') return <p className="hc-big-state">Up to date <span className="hc-muted">({u.from})</span></p>;
  const copy = () => navigator.clipboard?.writeText(cmd).then(() => setCopied(true), () => setCopied(false));
  return (
    <div className="hc-update">
      <p>
        {u.container && u.digest ? <>A new <code>:{u.from}</code> image is published.</> : <><code>{u.from}</code> → <code>{u.to}</code></>}
        {u.url && <> · <a href={u.url} target="_blank" rel="noreferrer">Release notes</a></>}
      </p>
      {u.container ? (
        <>
          <p className="hc-muted">
            Back up first.{' '}
            {!u.digest && <>In <code>docker-compose.yml</code> (NAS and repo), change the {u.service} image tag to <code>:{u.to}</code>. Then </>}
            {u.digest ? 'Run' : 'run'} in the NAS stack folder:
          </p>
          <div className="hc-cmd">
            <pre><code>{cmd}</code></pre>
            <button type="button" className="hc-icon-btn" aria-label={copied ? 'Copied' : 'Copy commands'} title={copied ? 'Copied' : 'Copy'} onClick={copy}>
              <Icon path={copied ? mdiCheck : mdiContentCopy} size={18} />
            </button>
          </div>
        </>
      ) : (
        <p className="hc-muted">Install it from the device's own app or admin page (for example DSM → Update &amp; Restore).</p>
      )}
    </div>
  );
}
