import {
  mdiBookmarkOutline, mdiBookmarkPlusOutline, mdiClose, mdiDeleteOutline, mdiFolderOutline, mdiHistory, mdiHomeOutline,
  mdiLogout, mdiMenu, mdiPackageUp, mdiPencil, mdiShape,
} from '@mdi/js';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { MAX_QUERIES, type ViewPrefs } from './util';

export const VIEWS: Array<{ key: string; label: string; icon: string; group: ViewPrefs['group']; sort: ViewPrefs['sort'] }> = [
  { key: 'domain', label: 'By type', icon: mdiShape, group: 'domain', sort: 'name' },
  { key: 'area', label: 'By area', icon: mdiHomeOutline, group: 'area', sort: 'name' },
  { key: 'recent', label: 'Recently changed', icon: mdiHistory, group: 'none', sort: 'recent' },
  { key: 'custom', label: 'My groups', icon: mdiFolderOutline, group: 'custom', sort: 'name' },
];

export const viewOf = (p: ViewPrefs) => VIEWS.find((v) => v.group === p.group && (v.group !== 'none' || v.sort === p.sort));

interface Props {
  id: string;
  /** Phone drawer open. */
  open: boolean;
  onClose: () => void;
  /** Desktop: icons only. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  prefs: ViewPrefs;
  onView: (v: (typeof VIEWS)[number]) => void;
  /** Sections of the current view: [dom id, title, count]. */
  sections: Array<[string, string, number]>;
  onJump: (domId: string) => void;
  groups: Array<[string, number]>;
  onOpenGroup: (g: string) => void;
  onRenameGroup: (from: string, to: string) => void;
  onDeleteGroup: (g: string) => void;
  filter: string;
  onSaveQuery: () => void;
  queryMsg: string;
  onRunQuery: (q: string) => void;
  onDeleteQuery: (q: string) => void;
  updates: number;
  onUpdates: () => void;
  onSignOut?: () => void;
}

/** Home Assistant style sidebar: a fixed rail on wide screens (collapsible), a drawer on phones. */
export function Sidebar(p: Props) {
  const ref = useRef<HTMLElement>(null);
  const current = viewOf(p.prefs);
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    if (!p.open) return;
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [p.open, p.onClose]);

  const item = (key: string, icon: string, label: string, onClick: () => void, opts: { current?: boolean; badge?: number } = {}) => (
    <button key={key} type="button" className="hc-side-item" aria-current={opts.current ? 'page' : undefined} title={p.collapsed ? label : undefined} onClick={onClick}>
      <Icon path={icon} />
      <span className="hc-side-label">{label}</span>
      {opts.badge ? <span className="hc-side-badge" aria-label={`${opts.badge} available`}>{opts.badge}</span> : null}
    </button>
  );

  return (
    <>
      {p.open && <div className="hc-backdrop" onClick={p.onClose} />}
      <aside id={p.id} ref={ref} className="hc-side" data-open={p.open || undefined} data-collapsed={p.collapsed || undefined} aria-label="Navigation">
        <div className="hc-side-head">
          <button type="button" className="hc-icon-btn hc-side-toggle" aria-label="Collapse sidebar" aria-expanded={!p.collapsed} onClick={p.onToggleCollapsed}>
            <Icon path={mdiMenu} />
          </button>
          <button type="button" className="hc-icon-btn hc-side-close" aria-label="Close navigation" onClick={p.onClose}>
            <Icon path={mdiClose} />
          </button>
          <span className="hc-side-brand">homecloud</span>
        </div>

        <nav className="hc-side-scroll" aria-label="Views">
          <ul>
            {VIEWS.map((v) => (
              <li key={v.key}>
                {item(v.key, v.icon, v.label, () => p.onView(v), { current: v === current && !(v.key === 'custom' && p.prefs.only) })}
                {v === current && v.key !== 'custom' && p.sections.length > 1 && (
                  <ul className="hc-side-sub" aria-label={`${v.label} sections`}>
                    {p.sections.map(([id, title, n]) => (
                      <li key={id}>
                        <button type="button" className="hc-side-subitem" onClick={() => p.onJump(id)}>
                          <span className="hc-side-label">{title}</span>
                          <span className="hc-side-count">{n}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {v.key === 'custom' && p.groups.length > 0 && (
                  <ul className="hc-side-sub" aria-label="My groups">
                    {p.groups.map(([g, n]) => (
                      <li key={g} className="hc-side-row">
                        {renaming === g ? (
                          <form
                            className="hc-side-rename"
                            onSubmit={(e) => {
                              e.preventDefault();
                              const to = String(new FormData(e.currentTarget).get('name') ?? '').trim();
                              if (to && to !== g) p.onRenameGroup(g, to);
                              setRenaming(null);
                            }}
                          >
                            <input name="name" className="hc-input" defaultValue={g} aria-label={`New name for ${g}`} maxLength={40} autoFocus onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setRenaming(null))} onBlur={() => setRenaming(null)} />
                          </form>
                        ) : (
                          <>
                            <button type="button" className="hc-side-subitem" aria-current={(current?.key === 'custom' && p.prefs.only === g) || undefined} onClick={() => p.onOpenGroup(g)}>
                              <span className="hc-side-label">{g}</span>
                              <span className="hc-side-count">{n}</span>
                            </button>
                            <span className="hc-side-tools">
                              <button type="button" className="hc-icon-btn" aria-label={`Rename group ${g}`} title="Rename" onClick={() => setRenaming(g)}><Icon path={mdiPencil} size={16} /></button>
                              <button type="button" className="hc-icon-btn" aria-label={`Delete group ${g}`} title="Delete" onClick={() => p.onDeleteGroup(g)}><Icon path={mdiDeleteOutline} size={16} /></button>
                            </span>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          <div className="hc-side-section">
            <h2 className="hc-side-heading">Saved searches <span className="hc-side-count">{p.prefs.queries.length}/{MAX_QUERIES}</span></h2>
            <ul>
              {p.prefs.queries.map((q) => (
                <li key={q} className="hc-side-row">
                  <button type="button" className="hc-side-subitem" aria-current={q === p.filter.trim() || undefined} onClick={() => p.onRunQuery(q)}>
                    <Icon path={mdiBookmarkOutline} size={18} />
                    <span className="hc-side-label">{q}</span>
                  </button>
                  <span className="hc-side-tools">
                    <button type="button" className="hc-icon-btn" aria-label={`Delete saved search ${q}`} title="Delete" onClick={() => p.onDeleteQuery(q)}><Icon path={mdiDeleteOutline} size={16} /></button>
                  </span>
                </li>
              ))}
            </ul>
            {p.filter.trim() ? (
              <button type="button" className="hc-side-subitem hc-side-add" onClick={p.onSaveQuery}>
                <Icon path={mdiBookmarkPlusOutline} size={18} />
                <span className="hc-side-label">Save “{p.filter.trim()}”</span>
              </button>
            ) : (
              !p.prefs.queries.length && <p className="hc-side-hint">Type in the search box, then save it here.</p>
            )}
            {p.queryMsg && <p className="hc-side-hint" role="status">{p.queryMsg}</p>}
          </div>
        </nav>

        <div className="hc-side-foot">
          {p.updates > 0 && item('updates', mdiPackageUp, 'Updates', p.onUpdates, { badge: p.updates })}
          {p.onSignOut && item('signout', mdiLogout, 'Sign out', p.onSignOut)}
        </div>
      </aside>
    </>
  );
}
