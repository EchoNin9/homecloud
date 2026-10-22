import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Entity, Home, HomeCloudClient } from '../client';
import { EntityCard, type Action } from './EntityCard';
import { usePoll } from './usePoll';
import { DEFAULT_PREFS, domainOf, errorMessage, formatLastSeen, organize, sunTimes, warnings, type ViewPrefs } from './util';
import './dashboard.css';

export interface HomeCloudDashboardProps {
  client: HomeCloudClient;
  /** Pin a home. If omitted, a picker is shown. */
  homeId?: string;
  /** Poll interval in ms while the tab is visible. Default 5000. */
  pollMs?: number;
  /** Shows a "Sign out" button in the title bar. */
  onSignOut?: () => void;
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

// ponytail: per-browser prefs in localStorage; move to the API if they need to sync across devices.
function usePrefs(homeId: string | undefined) {
  const key = `hc.prefs.${homeId ?? ''}`;
  const load = (): ViewPrefs => {
    try {
      return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(key) ?? '{}') };
    } catch {
      return DEFAULT_PREFS;
    }
  };
  const [state, setState] = useState(() => ({ key, prefs: load() }));
  const prefs = state.key === key ? state.prefs : load();
  const update = useCallback(
    (patch: Partial<ViewPrefs>) =>
      setState((cur) => {
        const next = { ...(cur.key === key ? cur.prefs : load()), ...patch };
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* storage unavailable: prefs last for this session only */
        }
        return { key, prefs: next };
      }),
    [key],
  );
  return [prefs, update] as const;
}

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

/** Toggle an entity in a named group; creates the group if new, drops it when empty. */
function toggleInGroup(groups: Record<string, string[]>, name: string, id: string) {
  const next = toggle(groups[name] ?? [], id);
  const { [name]: _old, ...rest } = groups;
  return next.length ? { ...rest, [name]: next } : rest;
}

export function HomeCloudDashboard({ client, homeId: pinnedHome, pollMs = 5000, onSignOut }: HomeCloudDashboardProps) {
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
  const [prefs, setPrefs] = usePrefs(pinnedHome ?? selected);
  const [navOpen, setNavOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [bulkGroup, setBulkGroup] = useState('');
  const groupListId = useId();
  const navId = useId();

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
    return organize(merged, filter, prefs);
  }, [entities, patches, filter, prefs]);
  const alerts = useMemo(() => warnings(entities ?? []), [entities]);
  const sun = useMemo(() => sunTimes(entities ?? []), [entities]);
  const shownIds = groups.flatMap(([, , list]) => list.map((e) => e.entity_id));
  const stopSelecting = () => {
    setSelecting(false);
    setPicked([]);
  };
  const addAll = (list: string[], ids: string[]) => [...new Set([...list, ...ids])];
  const dropAll = (list: string[], ids: string[]) => list.filter((x) => !ids.includes(x));
  const bulkToGroup = (add: boolean) => {
    const g = bulkGroup.trim();
    if (!g) return;
    const next = add ? addAll(prefs.groups[g] ?? [], picked) : dropAll(prefs.groups[g] ?? [], picked);
    const { [g]: _old, ...rest } = prefs.groups;
    setPrefs({ groups: next.length ? { ...rest, [g]: next } : rest });
  };
  const sectionId = (key: string) => `${homeLabelId}-${key}`;
  const goTo = (id: string) => {
    setNavOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const goToEntity = (entityId: string) => {
    const el = document.getElementById(`hc-e-${entityId}`);
    if (!el) {
      setFilter(entityId); // hidden or filtered out: narrow the view to it instead
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('hc-flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('hc-flash');
  };
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const groupNames = useMemo(() => Object.keys(prefs.groups).sort((a, b) => a.localeCompare(b)), [prefs.groups]);
  const hiddenCount = useMemo(() => {
    const ids = new Set((entities ?? []).map((e) => e.entity_id));
    return prefs.hidden.filter((id) => ids.has(id)).length;
  }, [entities, prefs.hidden]);

  const switchHome = (id: string) => {
    setEntities(null);
    setPatches({});
    setSelected(id);
  };

  const controlsDisabled = home ? !home.online : false;
  const loading = homes === null && !error;

  return (
    <section className="hc-dash" aria-label="homecloud dashboard">
      <div className="hc-topbar">
        <span className="hc-brand">homecloud</span>
        {(sun.rise || sun.set) && (
          <span className="hc-sun">
            {sun.rise && (
              <span title="Today’s sunrise">
                <span aria-hidden="true">☀︎</span> sunrise {sun.rise}
              </span>
            )}
            {sun.set && (
              <span title="Today’s sunset">
                <span aria-hidden="true">☾</span> sunset {sun.set}
              </span>
            )}
          </span>
        )}
        {onSignOut && (
          <button type="button" className="hc-link" onClick={onSignOut}>Sign out</button>
        )}
      </div>
      <header className="hc-header">
        <div className="hc-home">
          <button
            type="button"
            className="hc-btn hc-btn-icon"
            aria-label="Open navigation"
            aria-expanded={navOpen}
            aria-controls={navId}
            onClick={() => setNavOpen(true)}
          >
            ☰
          </button>
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
            placeholder="Filter by name, id or area"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </header>

      {navOpen && <div className="hc-backdrop" onClick={() => setNavOpen(false)} />}
      <nav id={navId} className="hc-nav" data-open={navOpen || undefined} aria-label="Sections">
        <div className="hc-nav-head">
          <span>Sections</span>
          <button type="button" className="hc-btn hc-btn-icon" aria-label="Close navigation" onClick={() => setNavOpen(false)}>×</button>
        </div>
        <ul>
          {alerts.length > 0 && (
            <li>
              <button type="button" className="hc-nav-link" onClick={() => goTo(sectionId('_warn'))}>
                Warnings <span className="hc-count">{alerts.length}</span>
              </button>
            </li>
          )}
          {groups.map(([key, title, list]) => (
            <li key={key}>
              <button type="button" className="hc-nav-link" onClick={() => goTo(sectionId(key))}>
                {title} <span className="hc-count">{list.length}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {alerts.length > 0 && (
        <section id={sectionId('_warn')} className="hc-warnings" aria-label="Warnings">
          {alerts.map((w) => (
            <button key={w.entity.entity_id} type="button" className="hc-warn" data-kind={w.kind} onClick={() => goToEntity(w.entity.entity_id)}>
              <span className="hc-warn-kind">{w.kind === 'door' ? 'Door open' : 'Drive hot'}</span>
              <span className="hc-warn-text">{w.text}</span>
            </button>
          ))}
        </section>
      )}

      <div className="hc-toolbar">
        <label className="hc-field">
          <span>Sort</span>
          <select className="hc-select" value={prefs.sort} onChange={(e) => setPrefs({ sort: e.target.value as ViewPrefs['sort'] })}>
            <option value="name">Name</option>
            <option value="recent">Recently changed</option>
          </select>
        </label>
        <label className="hc-field">
          <span>Group</span>
          <select className="hc-select" value={prefs.group} onChange={(e) => setPrefs({ group: e.target.value as ViewPrefs['group'] })}>
            <option value="domain">By type</option>
            <option value="area">By area</option>
            <option value="custom">My groups</option>
            <option value="none">None</option>
          </select>
        </label>
        <button type="button" className="hc-btn" aria-pressed={selecting} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
          {selecting ? 'Done selecting' : 'Select'}
        </button>
        {prefs.group === 'custom' && Object.keys(prefs.groups).length > 0 && (
          <details className="hc-menu">
            <summary className="hc-btn">Manage groups</summary>
            <div className="hc-menu-body">
              {Object.keys(prefs.groups)
                .sort((a, b) => a.localeCompare(b))
                .map((g) => (
                  <div key={g} className="hc-row">
                    <span className="hc-grow">{g} <span className="hc-count">{prefs.groups[g].length}</span></span>
                    <button
                      type="button"
                      className="hc-btn"
                      onClick={() => {
                        const n = window.prompt('Rename group', g)?.trim();
                        if (n && n !== g && !prefs.groups[n]) {
                          const { [g]: ids, ...rest } = prefs.groups;
                          setPrefs({ groups: { ...rest, [n]: ids } });
                        }
                      }}
                    >
                      Rename<span className="hc-sr"> {g}</span>
                    </button>
                    <button
                      type="button"
                      className="hc-btn"
                      onClick={() => {
                        const { [g]: _gone, ...rest } = prefs.groups;
                        setPrefs({ groups: rest });
                      }}
                    >
                      Delete<span className="hc-sr"> {g}</span>
                    </button>
                  </div>
                ))}
            </div>
          </details>
        )}
        {hiddenCount > 0 && (
          <label className="hc-field hc-check">
            <input type="checkbox" checked={prefs.showHidden} onChange={(e) => setPrefs({ showHidden: e.target.checked })} />
            <span>Show hidden ({hiddenCount})</span>
          </label>
        )}
      </div>

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
        groups.map(([key, title, list]) => (
          <section key={key} className="hc-group" aria-labelledby={sectionId(key)}>
            <h2 id={sectionId(key)} className="hc-group-title">
              {title} <span className="hc-count">{list.length}</span>
            </h2>
            <ul className="hc-grid">
              {list.map((e) => (
                <EntityCard
                  key={e.entity_id}
                  entity={e}
                  disabled={controlsDisabled}
                  busy={!!busy[e.entity_id]}
                  onAction={onAction}
                  fav={prefs.favs.includes(e.entity_id)}
                  hidden={prefs.hidden.includes(e.entity_id)}
                  onToggleFav={() => setPrefs({ favs: toggle(prefs.favs, e.entity_id) })}
                  onToggleHidden={() => setPrefs({ hidden: toggle(prefs.hidden, e.entity_id) })}
                  selecting={selecting}
                  selected={picked.includes(e.entity_id)}
                  onSelect={() => setPicked((p) => toggle(p, e.entity_id))}
                  groupNames={groupNames}
                  inGroups={groupNames.filter((g) => prefs.groups[g].includes(e.entity_id))}
                  onToggleGroup={(g) => setPrefs({ groups: toggleInGroup(prefs.groups, g, e.entity_id) })}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      {selecting && (
        <div className="hc-bulk" role="region" aria-label="Bulk actions">
          <span className="hc-bulk-count">{picked.length} selected</span>
          <button type="button" className="hc-btn" onClick={() => setPicked((p) => addAll(p, shownIds))}>
            Select all shown ({shownIds.length})
          </button>
          <button type="button" className="hc-btn" disabled={!picked.length} onClick={() => setPicked([])}>Clear</button>
          <span className="hc-bulk-group">
            <input
              className="hc-input"
              list={groupListId}
              placeholder="Group name"
              aria-label="Group name for selected"
              maxLength={40}
              value={bulkGroup}
              onChange={(e) => setBulkGroup(e.target.value)}
            />
            <datalist id={groupListId}>
              {groupNames.map((g) => <option key={g} value={g} />)}
            </datalist>
            <button type="button" className="hc-btn hc-btn-primary" disabled={!picked.length || !bulkGroup.trim()} onClick={() => bulkToGroup(true)}>Add to group</button>
            <button type="button" className="hc-btn" disabled={!picked.length || !prefs.groups[bulkGroup.trim()]} onClick={() => bulkToGroup(false)}>Remove</button>
          </span>
          <button type="button" className="hc-btn" disabled={!picked.length} onClick={() => setPrefs({ favs: addAll(prefs.favs, picked) })}>Favourite</button>
          <button type="button" className="hc-btn" disabled={!picked.length} onClick={() => setPrefs({ hidden: addAll(prefs.hidden, picked) })}>Hide</button>
          <button type="button" className="hc-btn" disabled={!picked.length} onClick={() => setPrefs({ hidden: dropAll(prefs.hidden, picked) })}>Unhide</button>
          <button type="button" className="hc-btn" onClick={stopSelecting}>Done</button>
        </div>
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
