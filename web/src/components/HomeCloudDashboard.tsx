import { mdiAlertCircleOutline, mdiArrowDown, mdiArrowLeft, mdiArrowRight, mdiArrowUp, mdiCursorMove, mdiBookmarkPlusOutline, mdiFolderPlusOutline, mdiCheckboxMultipleMarkedOutline, mdiDocker, mdiDotsVertical, mdiDoorOpen, mdiHarddisk, mdiMagnify, mdiMenu, mdiPackageUp, mdiWeatherSunsetDown, mdiWeatherSunsetUp } from '@mdi/js';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react';
import type { Entity, Home, HomeCloudClient } from '../client';
import { EntityCard, type Action } from './EntityCard';
import { isTracked } from './history';
import { Icon } from './icons';
import { MoreInfo, UpdateBody } from './MoreInfo';
import { Sidebar } from './Sidebar';
import { usePoll } from './usePoll';
import { DEFAULT_PREFS, MAX_QUERIES, domainOf, errorMessage, formatLastSeen, friendlyName, groupIds, matchesFilter, dropIndex, moveGroup, moveTo, organize, saveQuery, setMembers, sunTimes, updateInfo, warnings, type ViewPrefs } from './util';
import { getTheme, initTheme, setTheme, type Theme } from '../theme';
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

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

// Prefs live in localStorage and sync to the account (docs/contract.md "Prefs").
// `<key>.dirty` marks local edits the server hasn't confirmed; they win over the server copy.
// ponytail: last write wins across devices; merge per field if two devices edit at once.
function usePrefs(client: HomeCloudClient, homeId: string | undefined) {
  const key = `hc.prefs.${homeId ?? ''}`;
  const load = (): ViewPrefs => {
    try {
      return { ...DEFAULT_PREFS, ...JSON.parse(store.get(key) ?? '{}') };
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
        store.set(key, JSON.stringify(next));
        store.set(`${key}.dirty`, '1');
        return { key, prefs: next };
      }),
    [key],
  );

  const push = useCallback(
    (p: ViewPrefs) => {
      if (!homeId) return;
      client.putPrefs(homeId, p).then(() => store.set(`${key}.dirty`, null), () => { /* stays dirty; retried on next edit or load */ });
    },
    [client, homeId, key],
  );

  // Pull once per home: server wins unless this browser has unsynced edits.
  useEffect(() => {
    if (!homeId) return;
    let live = true;
    client.getPrefs<Partial<ViewPrefs>>(homeId).then(
      (r) => {
        if (!live) return;
        if (store.get(`${key}.dirty`) || (!r.prefs && store.get(key))) return push(load());
        if (!r.prefs) return;
        const next = { ...DEFAULT_PREFS, ...r.prefs };
        store.set(key, JSON.stringify(next));
        setState({ key, prefs: next });
      },
      () => { /* offline or old API: local prefs only */ },
    );
    return () => { live = false; };
  }, [client, homeId, key, push]);

  // Push edits, debounced.
  useEffect(() => {
    if (state.key !== key || !store.get(`${key}.dirty`)) return;
    const t = setTimeout(() => push(state.prefs), 1000);
    return () => clearTimeout(t);
  }, [state, key, push]);

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
  const [prefs, setPrefs] = usePrefs(client, pinnedHome ?? selected);
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, toggleCollapsed] = useCollapsed();
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [bulkGroup, setBulkGroup] = useState('');
  const [arranging, setArranging] = useState<string | null>(null); // group name
  const dragId = useRef<string | null>(null);
  const groupListId = useId();
  const navId = useId();
  const menuRef = useRef<HTMLDetailsElement>(null);
  const themeId = useId();
  const [theme, setThemeState] = useState<Theme>(getTheme);
  useEffect(initTheme, []); // no-op when the host app already called it

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
  const hiddenMatches = useMemo(
    () => (prefs.showHidden || !filter.trim() ? 0 : merged.filter((e) => prefs.hidden.includes(e.entity_id) && matchesFilter(e, filter)).length),
    [merged, filter, prefs.hidden, prefs.showHidden],
  );
  const shownIds = groups.flatMap(([, , list]) => list.map((e) => e.entity_id));
  const stopSelecting = () => {
    setSelecting(false);
    setPicked([]);
    setBulkMsg(null);
  };
  const addAll = (list: string[], ids: string[]) => [...new Set([...list, ...ids])];
  const dropAll = (list: string[], ids: string[]) => list.filter((x) => !ids.includes(x));
  /** Last bulk change, with the prefs it replaced so it can be undone. */
  const [bulkMsg, setBulkMsg] = useState<{ text: string; undo: Partial<ViewPrefs> } | null>(null);
  const bulk = (text: string, patch: Partial<ViewPrefs>) => {
    const undo = Object.fromEntries(Object.keys(patch).map((k) => [k, prefs[k as keyof ViewPrefs]])) as Partial<ViewPrefs>;
    setPrefs(patch);
    setBulkMsg({ text, undo });
  };
  const n = (k: number) => `${k} ${k === 1 ? 'entity' : 'entities'}`;
  const bulkToGroup = (add: boolean) => {
    const g = bulkGroup.trim();
    if (!g) return;
    const isNew = !prefs.groups[g];
    bulk(
      add ? `${isNew ? 'Created' : 'Added to'} “${g}”: ${n(picked.length)}` : `Removed ${n(picked.length)} from “${g}”`,
      setMembers(prefs, g, picked, add, entities ?? []),
    );
  };
  const sectionId = (key: string) => `${homeLabelId}-${key}`;
  const [queryMsg, setQueryMsg] = useState('');
  const onSaveQuery = () => {
    const next = saveQuery(prefs.queries, filter);
    if (next) {
      setPrefs({ queries: next });
      setQueryMsg('');
    } else setQueryMsg(`Limit is ${MAX_QUERIES}. Delete one first.`);
  };
  const closeNav = useCallback(() => setNavOpen(false), []);
  // Sidebar section jumps put the heading at the top, even near the end of the page: a section that
  // ends less than a screen from the bottom gets just enough temporary space below the last tile.
  const mainRef = useRef<HTMLElement>(null);
  const clearJumpSpace = () => mainRef.current?.style.removeProperty('padding-bottom');
  const jumpTo = (id: string) => {
    const el = document.getElementById(id);
    const main = mainRef.current;
    if (!el || !main) return;
    clearJumpSpace();
    const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
    const target = el.getBoundingClientRect().top + window.scrollY - margin;
    const short = target + window.innerHeight - document.documentElement.scrollHeight;
    if (short > 0) main.style.paddingBottom = `${parseFloat(getComputedStyle(main).paddingBottom) + short}px`;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  /** Results bar: turn the current search into a live group named after it, and open it. */
  const saveAsGroup = () => {
    const q = filter.trim();
    const base = q.charAt(0).toUpperCase() + q.slice(1);
    let name = base;
    for (let i = 2; prefs.groups[name]; i++) name = `${base} ${i}`;
    setPrefs({ groups: { ...prefs.groups, [name]: [] }, groupQueries: { ...prefs.groupQueries, [name]: q }, group: 'custom', sort: 'name', only: name });
    setFilter('');
  };
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
        setSelecting(false);
        setPicked([]);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selecting]);

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
          setPrefs({ group: v.group, sort: v.sort, only: '' });
          closeNav();
          clearJumpSpace();
          window.scrollTo({ top: 0 });
        }}
        sections={groups.map(([key, title, list]): [string, string, number] => [sectionId(key), title, list.length])}
        onJump={(id) => {
          closeNav();
          jumpTo(id);
        }}
        groups={groupNames.map((g): [string, number] => [g, groupIds(g, entities ?? [], prefs).size])}
        onOpenGroup={(g) => {
          setPrefs({ group: 'custom', sort: 'name', only: g });
          closeNav();
          clearJumpSpace();
          window.scrollTo({ top: 0 });
        }}
        onRenameGroup={(from, to) => {
          if (!prefs.groups[to]) setPrefs(moveGroup(prefs, from, to));
        }}
        onDeleteGroup={(g) => {
          setPrefs(moveGroup(prefs, g, null));
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

      <main className="hc-main" ref={mainRef}>
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
              <div className="hc-menu-theme">
                <span id={themeId}>Theme</span>
                <span className="hc-seg" role="group" aria-labelledby={themeId}>
                  {(['system', 'light', 'dark'] as const).map((t) => (
                    <button key={t} type="button" aria-pressed={theme === t} onClick={() => { setTheme(t); setThemeState(t); }}>
                      {{ system: 'System', light: 'Light', dark: 'Dark' }[t]}
                    </button>
                  ))}
                </span>
              </div>
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
              <button type="button" className="hc-badge" data-kind="sun" title="Today’s sunrise: open Sun &amp; moon" onClick={() => setInfoFor('sun.sun')}>
                <Icon path={mdiWeatherSunsetUp} size={18} /><span className="hc-badge-text"><span className="hc-sr">Sunrise </span>{sun.rise}</span>
              </button>
            )}
            {sun.set && (
              <button type="button" className="hc-badge" data-kind="sun" title="Today’s sunset: open Sun &amp; moon" onClick={() => setInfoFor('sun.sun')}>
                <Icon path={mdiWeatherSunsetDown} size={18} /><span className="hc-badge-text"><span className="hc-sr">Sunset </span>{sun.set}</span>
              </button>
            )}
          </section>
        )}

        {prefs.group === 'custom' && prefs.only && prefs.groups[prefs.only] && (
          <div className="hc-group-head">
            <label className="hc-group-query">
              <span>Members matching</span>
              <span className="hc-search-box">
                <Icon path={mdiMagnify} size={18} />
                <input
                  className="hc-input"
                  type="search"
                  placeholder="Add a search, e.g. bedroom"
                  value={prefs.groupQueries[prefs.only] ?? ''}
                  onChange={(e) => {
                    const q = e.target.value;
                    const { [prefs.only]: _q, ...rest } = prefs.groupQueries;
                    setPrefs({ groupQueries: q ? { ...rest, [prefs.only]: q } : rest });
                  }}
                />
              </span>
            </label>
            <span className="hc-muted">
              {(prefs.groups[prefs.only] ?? []).length} added by hand
              {(prefs.groupOut[prefs.only] ?? []).length > 0 && <> · {prefs.groupOut[prefs.only]!.length} removed from the search</>}
              {' '}· add or remove more with Select or an entity's Groups menu
            </span>
          </div>
        )}

        {filter.trim() && entities && (
          <div className="hc-results" role="status">
            <span>
              {shownIds.length} {shownIds.length === 1 ? 'match' : 'matches'} for “{filter.trim()}”
              {hiddenMatches > 0 && (
                <>
                  {' '}· {hiddenMatches} hidden
                  <button type="button" className="hc-link-btn" onClick={() => setPrefs({ showHidden: true })}>Show</button>
                </>
              )}
            </span>
            {shownIds.length > 0 && (
              <button
                type="button"
                className="hc-chip-btn"
                onClick={() => {
                  setSelecting(true);
                  setPicked(shownIds);
                }}
              >
                <Icon path={mdiCheckboxMultipleMarkedOutline} size={18} /> Select {shownIds.length === 1 ? 'it' : `all ${shownIds.length}`}
              </button>
            )}
            <button type="button" className="hc-chip-btn" onClick={saveAsGroup}>
              <Icon path={mdiFolderPlusOutline} size={18} /> Save as group
            </button>
            {!prefs.queries.includes(filter.trim()) && (
              <button type="button" className="hc-chip-btn" onClick={onSaveQuery}>
                <Icon path={mdiBookmarkPlusOutline} size={18} /> Save search
              </button>
            )}
            {queryMsg && <span className="hc-muted">{queryMsg}</span>}
          </div>
        )}

        {error != null && (
          <p className="hc-banner" role="alert">
            <Icon path={mdiAlertCircleOutline} size={20} /> Can't reach HomeCloud ({errorMessage(error)}). Showing last known state; retrying…
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
          <p className="hc-empty">
            {filter ? `No entities match “${filter}”.`
              : prefs.group === 'custom' && prefs.only ? `“${prefs.only}” has no members yet. Add a search above, or pick entities with Select.`
              : 'This home has not reported any entities yet.'}
          </p>
        ) : (
          groups.map(([key, title, list]) => {
            const arr = arranging === title && key.startsWith('grp:') && !selecting;
            const ids = list.map((x) => x.entity_id);
            const move = (id: string, to: number) =>
              setPrefs({ order: { ...prefs.order, [title]: moveTo(ids, id, to, prefs.order[title]) }, customOrder: true });
            const dragging = () => (dragId.current && ids.includes(dragId.current) ? dragId.current : null);
            return (
            <section key={key} className="hc-section" aria-labelledby={sectionId(key)}>
              <div className="hc-section-head">
              <h2 id={sectionId(key)} className="hc-section-title">
                {title} <span className="hc-count">{list.length}</span>
              </h2>
                {key.startsWith('grp:') && key !== 'grp:' && !selecting && (
                  <span className="hc-section-tools">
                    <button type="button" className="hc-chip-btn" onClick={() => setPrefs({ customOrder: !prefs.customOrder })}>
                      Toggle sort <span className="hc-muted">{prefs.customOrder ? 'Custom' : prefs.sort === 'recent' ? 'Recent' : 'A–Z'}</span>
                    </button>
                    <button type="button" className="hc-chip-btn" onClick={() => setArranging(arranging === title ? null : title)}>
                      <Icon path={mdiCursorMove} size={18} /> {arranging === title ? 'Done' : 'Arrange'}
                    </button>
                  </span>
                )}
              </div>
              {arranging === title && key.startsWith('grp:') && (
                <p className="hc-muted hc-arrange-hint">Drag a tile anywhere in the group, or use the arrows. Saved automatically.</p>
              )}
              <ul
                className="hc-tiles"
                {...(arr ? {
                  // Drop anywhere in the grid: gaps, either half of a tile, or after the last one.
                  onDragOver: (ev: DragEvent<HTMLUListElement>) => { if (dragging()) ev.preventDefault(); },
                  onDrop: (ev: DragEvent<HTMLUListElement>) => {
                    ev.preventDefault();
                    const id = dragging();
                    dragId.current = null;
                    if (!id) return;
                    const rects = [...ev.currentTarget.children].map((c) => c.getBoundingClientRect());
                    move(id, dropIndex(rects, ids.indexOf(id), ev.clientX, ev.clientY));
                  },
                } : {})}
              >
                {list.map((e, i) => {
                  const nudge = (to: number, dir: string) => {
                    move(e.entity_id, to);
                    requestAnimationFrame(() => document.getElementById(`hc-mv-${dir}-${e.entity_id}`)?.focus());
                  };
                  const cols = (el: HTMLElement) =>
                    getComputedStyle(el.closest('ul')!).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
                  const name = friendlyName(e);
                  const btn = (dir: string, label: string, icon: string, off: boolean, to: (c: number) => number) => (
                    <button type="button" id={`hc-mv-${dir}-${e.entity_id}`} className="hc-icon-btn" aria-label={`Move ${name} ${label}`} disabled={off}
                      onClick={(ev) => nudge(Math.max(0, Math.min(list.length - 1, to(cols(ev.currentTarget)))), dir)}>
                      <Icon path={icon} size={18} />
                    </button>
                  );
                  return (
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
                      arranging={arr}
                      li={arr ? {
                        draggable: true,
                        onDragStart: (ev) => {
                          dragId.current = e.entity_id;
                          ev.dataTransfer.effectAllowed = 'move';
                          ev.dataTransfer.setData('text/plain', e.entity_id);
                        },
                        onDragEnd: () => { dragId.current = null; },
                      } : undefined}
                    >
                      {arr && (
                        <span className="hc-tile-move">
                          {btn('u', 'up a row', mdiArrowUp, i === 0, (c) => i - c)}
                          {btn('l', 'earlier', mdiArrowLeft, i === 0, () => i - 1)}
                          {btn('r', 'later', mdiArrowRight, i === list.length - 1, () => i + 1)}
                          {btn('d', 'down a row', mdiArrowDown, i === list.length - 1, (c) => i + c)}
                        </span>
                      )}
                    </EntityCard>
                  );
                })}
              </ul>
            </section>
          );
          })
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
              <button type="button" className="hc-btn hc-btn-primary" disabled={!picked.length || !bulkGroup.trim()} onClick={() => bulkToGroup(true)}>
                {bulkGroup.trim() && !prefs.groups[bulkGroup.trim()] ? 'Create group' : 'Add to group'}
              </button>
              <button type="button" className="hc-btn" disabled={!picked.length || !prefs.groups[bulkGroup.trim()]} onClick={() => bulkToGroup(false)}>Remove</button>
            </span>
            <button type="button" className="hc-btn" disabled={!picked.length} onClick={() => bulk(`Favourited ${n(picked.length)}`, { favs: addAll(prefs.favs, picked) })}>Favourite</button>
            <button type="button" className="hc-btn" disabled={!picked.length} onClick={() => bulk(`Hid ${n(picked.length)}`, { hidden: addAll(prefs.hidden, picked) })}>Hide</button>
            <button type="button" className="hc-btn" disabled={!picked.length} onClick={() => bulk(`Unhid ${n(picked.length)}`, { hidden: dropAll(prefs.hidden, picked) })}>Unhide</button>
            <button type="button" className="hc-btn hc-btn-primary" onClick={stopSelecting}>Done</button>
            {bulkMsg && (
              <p className="hc-bulk-msg" role="status">
                {bulkMsg.text}
                <button type="button" className="hc-link-btn" onClick={() => { setPrefs(bulkMsg.undo); setBulkMsg(null); }}>Undo</button>
              </p>
            )}
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
          inGroups={groupNames.filter((g) => groupIds(g, [info], prefs).has(info.entity_id))}
          onToggleGroup={(g) => setPrefs(setMembers(prefs, g, [info.entity_id], !groupIds(g, [info], prefs).has(info.entity_id), entities ?? []))}
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
