// Light/dark choice. The resolved mode goes on <html data-theme>, which app.css and dashboard.css key off.
// ponytail: per-browser, like the other view prefs (localStorage).

export type Theme = 'system' | 'light' | 'dark';

const KEY = 'hc.theme';
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

export const resolveTheme = (t: Theme, osDark: boolean): 'light' | 'dark' => (t === 'system' ? (osDark ? 'dark' : 'light') : t);

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: Theme = getTheme()) {
  document.documentElement.dataset.theme = resolveTheme(t, systemDark());
}

export function setTheme(t: Theme) {
  try {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
  applyTheme(t);
}

/** Call once at startup: applies the saved choice and follows OS changes while on "system". */
let started = false;
export function initTheme() {
  if (started) return;
  started = true;
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => getTheme() === 'system' && applyTheme());
}
