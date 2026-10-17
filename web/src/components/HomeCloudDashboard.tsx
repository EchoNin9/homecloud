import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Entity, Home, HomeCloudClient } from '../client';
import { EntityCard, type Action } from './EntityCard';
import { usePoll } from './usePoll';
import { domainOf, domainTitle, errorMessage, formatLastSeen, groupByDomain, matchesFilter } from './util';
import './dashboard.css';

export interface HomeCloudDashboardProps {
  client: HomeCloudClient;
  /** Pin a home. If omitted, a picker is shown. */
  homeId?: string;
  /** Poll interval in ms while the tab is visible. Default 5000. */
  pollMs?: number;
}

interface Patch {
  state?: string;
  attributes?: Record<string, unknown>;
}
interface Toast {
  id: number;
  text: string;
}

const PATCH_HOLD_MS = 4000;

export function HomeCloudDashboard({ client, homeId: pinnedHome, pollMs = 5000 }: HomeCloudDashboardProps) {
  const [homes, setHomes] = useState<Home[] | null>(null);
  const [selected, setSelected] = useState<string | undefined>(pinnedHome);
  const [entities, setEntities] = useState<Entity[] | null>(null);
  const [patches, setPatches] = useState<Record<string, Patch>>({});
  const [busy, setBusy] = useState<Record<string, number>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [filter, setFilter] = useState('');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const seq = useRef<Record<string, number>>({});
  const toastId = useRef(0);
  const homeLabelId = useId();
  const searchId = useId();

  useEffect(() => {
    if (pinnedHome) setSelected(pinnedHome);
  }, [pinnedHome]);

  const { error, refresh } = usePoll(
    async () => {
      const hs = await client.listHomes();
      setHomes(hs);
      const id = pinnedHome ?? selectedRef.current ?? hs[0]?.homeId;
      if (id !== selectedRef.current) setSelected(id);
      if (!id) return;
      const r = await client.listEntities(id);
      if (id === (pinnedHome ?? selectedRef.current ?? id)) setEntities(r.entities);
    },
    `${pinnedHome ?? selected ?? ''}`,
    pollMs,
  );

  const pushToast = useCallback((text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 7000);
  }, []);

  const home = homes?.find((h) => h.homeId === selected);

  const onAction = useCallback(
    async (entity: Entity, action: Action) => {
      const homeId = selectedRef.current;
      if (!homeId) return;
      const eid = entity.entity_id;
      const mine = (seq.current[eid] = (seq.current[eid] ?? 0) + 1);
      const latest = () => seq.current[eid] === mine;
      const dropPatch = () =>
        setPatches((p) => {
          const { [eid]: _gone, ...rest } = p;
          return rest;
        });
      if (action.patch) setPatches((p) => ({ ...p, [eid]: action.patch! }));
      setBusy((b) => ({ ...b, [eid]: (b[eid] ?? 0) + 1 }));
      try {
        const acc = await client.sendCommand(homeId, {
          domain: domainOf(eid),
          service: action.service,
          target: { entity_id: eid },
          ...(action.data ? { data: action.data } : {}),
        });
        const st = await client.waitForCommand(homeId, acc.id);
        if (st.status === 'error') throw new Error(st.error || 'command failed');
        if (latest()) {
          refresh();
          setTimeout(() => latest() && dropPatch(), PATCH_HOLD_MS);
        }
      } catch (e) {
        if (latest()) dropPatch();
        pushToast(`Couldn't ${action.label} ${entity.attributes.friendly_name ?? eid}: ${errorMessage(e)}`);
      } finally {
        setBusy((b) => {
          const n = (b[eid] ?? 1) - 1;
          const { [eid]: _gone, ...rest } = b;
          return n > 0 ? { ...rest, [eid]: n } : rest;
        });
      }
    },
    [client, pushToast, refresh],
  );

  const groups = useMemo(() => {
    const merged = (entities ?? []).map((e) => {
      const p = patches[e.entity_id];
      return p ? { ...e, state: p.state ?? e.state, attributes: { ...e.attributes, ...p.attributes } } : e;
    });
    return groupByDomain(merged.filter((e) => matchesFilter(e, filter)));
  }, [entities, patches, filter]);

  const switchHome = (id: string) => {
    setEntities(null);
    setPatches({});
    setSelected(id);
  };

  const controlsDisabled = home ? !home.online : false;
  const loading = homes === null && !error;

  return (
    <section className="hc-dash" aria-label="homecloud dashboard">
      <header className="hc-header">
        <div className="hc-home">
          {pinnedHome || (homes && homes.length === 1) ? (
            <h1 className="hc-home-name">{selected ?? 'No home'}</h1>
          ) : (
            <>
              <label id={homeLabelId} htmlFor={`${homeLabelId}-sel`} className="hc-sr">Home</label>
              <select
                id={`${homeLabelId}-sel`}
                className="hc-select"
                value={selected ?? ''}
                disabled={!homes?.length}
                onChange={(e) => switchHome(e.target.value)}
              >
                {!homes?.length && <option value="">{loading ? 'Loading…' : 'No homes'}</option>}
                {homes?.map((h) => (
                  <option key={h.homeId} value={h.homeId}>{h.homeId}</option>
                ))}
              </select>
            </>
          )}
          {home && (
            <>
              <span className={`hc-badge ${home.online ? 'hc-badge-on' : 'hc-badge-off'}`}>
                <span className="hc-dot" aria-hidden="true" />
                {home.online ? 'Online' : 'Offline'}
              </span>
              <span className="hc-meta" title={home.lastSeenTs ? new Date(home.lastSeenTs).toLocaleString() : undefined}>
                Last seen {formatLastSeen(home.lastSeenTs)}
              </span>
            </>
          )}
        </div>
        <div className="hc-search">
          <label htmlFor={searchId} className="hc-sr">Filter entities</label>
          <input
            id={searchId}
            type="search"
            className="hc-input"
            placeholder="Filter by name or id"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </header>

      {error != null && (
        <p className="hc-banner" role="alert">
          Can't reach homecloud ({errorMessage(error)}). Showing last known state; retrying…
        </p>
      )}
      {home && !home.online && (
        <p className="hc-banner hc-banner-warn">This home is offline, so controls are disabled and values may be stale.</p>
      )}

      {loading || (selected && entities === null && !error) ? (
        <p className="hc-empty" role="status">Loading…</p>
      ) : homes && homes.length === 0 ? (
        <p className="hc-empty">No homes yet. Once your NAS bridge connects, it will appear here.</p>
      ) : groups.length === 0 && entities ? (
        <p className="hc-empty">{filter ? `No entities match “${filter}”.` : 'This home has not reported any entities yet.'}</p>
      ) : (
        groups.map(([domain, list]) => (
          <section key={domain} className="hc-group" aria-labelledby={`${homeLabelId}-${domain}`}>
            <h2 id={`${homeLabelId}-${domain}`} className="hc-group-title">
              {domainTitle(domain)} <span className="hc-count">{list.length}</span>
            </h2>
            <ul className="hc-grid">
              {list.map((e) => (
                <EntityCard key={e.entity_id} entity={e} disabled={controlsDisabled} busy={!!busy[e.entity_id]} onAction={onAction} />
              ))}
            </ul>
          </section>
        ))
      )}

      <div className="hc-toasts" role="region" aria-label="Notifications" aria-live="assertive">
        {toasts.map((t) => (
          <div key={t.id} className="hc-toast" role="alert">
            <span>{t.text}</span>
            <button type="button" className="hc-toast-x" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>×</button>
          </div>
        ))}
      </div>
    </section>
  );
}
