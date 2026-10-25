import { mdiAlertCircleOutline, mdiDocker, mdiDotsVertical, mdiDoorOpen, mdiHarddisk, mdiMagnify, mdiMenu, mdiPackageUp, mdiWeatherSunsetDown, mdiWeatherSunsetUp } from '@mdi/js';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Entity, Home, HomeCloudClient } from '../client';
import { EntityCard, type Action } from './EntityCard';
import { isTracked } from './history';
import { Icon } from './icons';
import { MoreInfo, UpdateBody } from './MoreInfo';
import { Sidebar } from './Sidebar';
import { usePoll } from './usePoll';
import { DEFAULT_PREFS, MAX_QUERIES, domainOf, errorMessage, formatLastSeen, friendlyName, organize, saveQuery, sunTimes, updateInfo, warnings, type ViewPrefs } from './util';
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

// ponytail: per-viewer convenience, so plain localStorage.
function useCollapsed() {
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem('hc.side') === '1';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setV((c) => {
      try {
        localStorage.setItem('hc.side', c ? '0' : '1');
      } catch {
        /* this session only */
      }
      return !c;
    });
  return [v, toggle] as const;
}

const ALERT_ICON = { door: mdiDoorOpen, service: mdiDocker, drive: mdiHarddisk, update: mdiPackageUp };

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
  const [historyGlobs, setHistoryGlobs] = useState<string[]>([]);
  const [infoFor, setInfoFor] = useState<string | null>(null);
  const [updatesOpen, setUpdatesOpen] = useState(false);
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
  const [collapsed, toggleCollapsed] = useCollapsed();
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [bulkGroup, setBulkGroup] = useState('');
  const groupListId = useId();
  const navId = useId();
  const menuRef = useRef<HTMLDetailsElement>(null);

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
      if (id === (pinnedHome ?? selectedRef.current ?? id)) {
        setEntities(r.entities);
        setHistoryGlobs(r.historyEntities ?? []); // absent on older APIs: no history
      }
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
        pushToast(`Couldn't ${action.label} ${friendlyName(entity)}: ${errorMessage(e)}`);
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

  const merged = useMemo(
    () =>
      (entities ?? []).map((e) => {
        const p = patches[e.entity_id];
        return p ? { ...e, state: p.state ?? e.state, attributes: { ...e.attributes, ...p.attributes } } : e;
      }),
    [entities, patches],
  );
  const groups = useMemo(() => organize(merged, filter, prefs), [merged, filter, prefs]);
  const alerts = useMemo(() => warnings(entities ?? []), [entities]);
  const problems = alerts.filter((w) => w.kind !== 'update');
  const updates = alerts.filter((w) => w.kind === 'update');
  const sun = useMemo(() => sunTimes(entities ?? []), [entities]);
  const info = infoFor ? merged.find((e) => e.entity_id === infoFor) : undefined;
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
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  useEffect(() => {
    if (jumpTo) {
      document.getElementById(jumpTo)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setJumpTo(null);
    }
  }, [jumpTo, groups]);
  const [queryMsg, setQueryMsg] = useState('');
  const onSaveQuery = () => {
    const next = saveQuery(prefs.queries, filter);
    if (next) {
      setPrefs({ queries: next });
      setQueryMsg('');
    } else setQueryMsg(`Limit is ${MAX_QUERIES}. Delete one first.`);
  };
  const closeNav = useCallback(() => setNavOpen(false), []);

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
  const multiHome = !pinnedHome && (homes?.length ?? 0) > 1;

  return (
    <div className="hc-dash" data-collapsed={collapsed || undefined}>
      <Sidebar
        id={navId}
        open={navOpen}
        onClose={closeNav}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        prefs={prefs}
        onView={(v) => {
          setPrefs({ group: v.group, sort: v.sort });
          closeNav();
          window.scrollTo({ top: 0 });
        }}
        sections={groups.map(([key, title, list]): [string, string, number] => [sectionId(key), title, list.length])}
        onJump={(id) => {
          closeNav();
          document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
        groups={groupNames.map((g): [string, number] => [g, prefs.groups[g]!.length])}
        onOpenGroup={(g) => {
          setPrefs({ group: 'custom', sort: 'name' });
          closeNav();
          setJumpTo(sectionId(`grp:${g}`));
        }}
        onRenameGroup={(from, to) => {
          if (prefs.groups[to]) return;
          const { [from]: ids, ...rest } = prefs.groups;
          setPrefs({ groups: { ...rest, [to]: ids! } });
        }}
        onDeleteGroup={(g) => {
          const { [g]: _gone, ...rest } = prefs.groups;
          setPrefs({ groups: rest });
        }}
        filter={filter}
        onSaveQuery={onSaveQuery}
        queryMsg={queryMsg}
        onRunQuery={(q) => {
          setFilter(q);
          closeNav();
        }}
        onDeleteQuery={(q) => {
          setPrefs({ queries: prefs.queries.filter((x) => x !== q) });
          setQueryMsg('');
        }}
        updates={updates.length}
        onUpdates={() => {
          closeNav();
          setUpdatesOpen(true);
        }}
        onSignOut={onSignOut}
      />

      <main className="hc-main">
        <header className="hc-toolbar">
          <button type="button" className="hc-icon-btn hc-menu-btn" aria-label="Open navigation" aria-expanded={navOpen} aria-controls={navId} onClick={() => setNavOpen(true)}>
            <Icon path={mdiMenu} />
          </button>
          {multiHome ? (
            <>
              <label htmlFor={`${homeLabelId}-sel`} className="hc-sr">Home</label>
              <select id={`${homeLabelId}-sel`} className="hc-select hc-title-select" value={selected ?? ''} onChange={(e) => switchHome(e.target.value)}>
                {homes?.map((h) => <option key={h.homeId} value={h.homeId}>{h.homeId}</option>)}
              </select>
            </>
          ) : (
            <h1 className="hc-title">{selected ?? (loading ? 'homecloud' : 'No home')}</h1>
          )}
          {home && (
            <span
              className="hc-status"
              data-online={home.online || undefined}
              title={home.lastSeenTs ? `Last seen ${new Date(home.lastSeenTs).toLocaleString()}` : undefined}
            >
              <span className="hc-dot" aria-hidden="true" />
              {home.online ? 'Online' : 'Offline'}
              <span className="hc-status-seen"> · {formatLastSeen(home.lastSeenTs)}</span>
            </span>
          )}
          <div className="hc-search">
            <label htmlFor={searchId} className="hc-sr">Search entities</label>
            <Icon path={mdiMagnify} size={20} />
            <input id={searchId} type="search" className="hc-input" placeholder="Search" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <details className="hc-menu hc-overflow" ref={menuRef}>
            <summary className="hc-icon-btn" aria-label="More options"><Icon path={mdiDotsVertical} /></summary>
            <div className="hc-menu-body hc-menu-right" onClick={(e) => (e.target as HTMLElement).closest('button') && menuRef.current?.removeAttribute('open')}>
              <button type="button" className="hc-menu-item" onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
                {selecting ? 'Done selecting' : 'Select entities'}
              </button>
              {hiddenCount > 0 && (
                <label className="hc-menu-item hc-check">
                  <input type="checkbox" checked={prefs.showHidden} onChange={(e) => setPrefs({ showHidden: e.target.checked })} />
                  Show hidden ({hiddenCount})
                </label>
              )}
            </div>
          </details>
        </header>

        {(problems.length > 0 || updates.length > 0 || sun.rise || sun.set) && (
          <section id={sectionId('_warn')} className="hc-badges" aria-label="Status">
            {problems.map((w) => (
              <button key={w.entity.entity_id} type="button" className="hc-badge" data-kind={w.kind} onClick={() => setInfoFor(w.entity.entity_id)}>
                <Icon path={ALERT_ICON[w.kind]} size={18} />
                <span className="hc-badge-text">
                  <span className="hc-badge-label">{{ door: 'Door open', service: 'Service down', drive: 'Drive hot', update: '' }[w.kind]}</span>
                  {w.text}
                </span>
              </button>
            ))}
            {updates.length > 0 && (
              <button type="button" className="hc-badge" data-kind="update" onClick={() => (updates.length === 1 ? setInfoFor(updates[0]!.entity.entity_id) : setUpdatesOpen(true))}>
                <Icon path={mdiPackageUp} size={18} />
                <span className="hc-badge-text">{updates.length === 1 ? updates[0]!.text : `${updates.length} updates available`}</span>
              </button>
            )}
            {sun.rise && (
              <span className="hc-badge" data-kind="sun" title="Today’s sunrise">
                <Icon path={mdiWeatherSunsetUp} size={18} /><span className="hc-badge-text">{sun.rise}</span>
              </span>
            )}
            {sun.set && (
              <span className="hc-badge" data-kind="sun" title="Today’s sunset">
                <Icon path={mdiWeatherSunsetDown} size={18} /><span className="hc-badge-text">{sun.set}</span>
              </span>
            )}
          </section>
        )}

        {error != null && (
          <p className="hc-banner" role="alert">
            <Icon path={mdiAlertCircleOutline} size={20} /> Can't reach homecloud ({errorMessage(error)}). Showing last known state; retrying…
          </p>
        )}
        {home && !home.online && (
          <p className="hc-banner hc-banner-warn"><Icon path={mdiAlertCircleOutline} size={20} /> This home is offline, so controls are disabled and values may be stale.</p>
        )}

        {loading || (selected && entities === null && !error) ? (
          <p className="hc-empty" role="status">Loading…</p>
        ) : homes && homes.length === 0 ? (
          <p className="hc-empty">No homes yet. Once your NAS bridge connects, it will appear here.</p>
        ) : groups.length === 0 && entities ? (
          <p className="hc-empty">{filter ? `No entities match “${filter}”.` : 'This home has not reported any entities yet.'}</p>
        ) : (
          groups.map(([key, title, list]) => (
            <section key={key} className="hc-section" aria-labelledby={sectionId(key)}>
              <h2 id={sectionId(key)} className="hc-section-title">
                {title} <span className="hc-count">{list.length}</span>
              </h2>
              <ul className="hc-tiles">
                {list.map((e) => (
                  <EntityCard
                    key={e.entity_id}
                    entity={e}
                    disabled={controlsDisabled}
                    busy={!!busy[e.entity_id]}
                    onAction={onAction}
                    onOpen={() => setInfoFor(e.entity_id)}
                    hidden={prefs.hidden.includes(e.entity_id)}
                    selecting={selecting}
                    selected={picked.includes(e.entity_id)}
                    onSelect={() => setPicked((p) => toggle(p, e.entity_id))}
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
            <button type="button" className="hc-btn hc-btn-primary" onClick={stopSelecting}>Done</button>
          </div>
        )}
      </main>

      {info && selected && (
        <MoreInfo
          key={info.entity_id}
          client={client}
          homeId={selected}
          entity={info}
          disabled={controlsDisabled}
          busy={!!busy[info.entity_id]}
          onAction={onAction}
          tracked={isTracked(info.entity_id, historyGlobs)}
          fav={prefs.favs.includes(info.entity_id)}
          hidden={prefs.hidden.includes(info.entity_id)}
          onToggleFav={() => setPrefs({ favs: toggle(prefs.favs, info.entity_id) })}
          onToggleHidden={() => setPrefs({ hidden: toggle(prefs.hidden, info.entity_id) })}
          groupNames={groupNames}
          inGroups={groupNames.filter((g) => prefs.groups[g]!.includes(info.entity_id))}
          onToggleGroup={(g) => setPrefs({ groups: toggleInGroup(prefs.groups, g, info.entity_id) })}
          onClose={() => setInfoFor(null)}
        />
      )}
      {updatesOpen && <UpdatesDialog updates={updates.map((w) => w.entity)} onClose={() => setUpdatesOpen(false)} />}

      <div className="hc-toasts" role="region" aria-label="Notifications" aria-live="assertive">
        {toasts.map((t) => (
          <div key={t.id} className="hc-toast">
            <span>{t.text}</span>
            <button type="button" className="hc-toast-x" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Every available update, each with its how-to. Notify only. */
function UpdatesDialog({ updates, onClose }: { updates: Entity[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog ref={ref} className="hc-dialog" onClose={onClose} aria-labelledby="hc-upd-title">
      <h2 id="hc-upd-title">Updates</h2>
      {updates.length === 0 && <p className="hc-muted">Everything is up to date.</p>}
      {updates.map((e) => (
        <details key={e.entity_id} className="hc-update-item">
          <summary>
            <Icon path={mdiPackageUp} size={20} />
            <span>{updateInfo(e).container ? updateInfo(e).service : friendlyName(e)}</span>
          </summary>
          <UpdateBody entity={e} />
        </details>
      ))}
      <form method="dialog" className="hc-dialog-actions">
        <button className="hc-btn">Close</button>
      </form>
    </dialog>
  );
}
