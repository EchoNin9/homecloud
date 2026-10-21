import { challengeS256, generateVerifier, randomState } from './pkce';

export interface AuthConfig {
  clientId: string;
  /** Hosted UI domain, with or without https://, e.g. my-app.auth.us-east-1.amazoncognito.com */
  cognitoDomain: string;
  /** Defaults to current origin + path (without query/hash). Must be registered as a callback + sign-out URL. */
  redirectUri?: string;
  scope?: string;
  /** Which token to send to the API. Default 'id'. */
  tokenType?: 'id' | 'access';
}

interface StoredTokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  /** epoch ms when the access token expires */
  expiresAt: number;
}

export interface Auth {
  /** Redirects to the hosted UI; 'forgotPassword' opens its reset-password page (same PKCE flow). */
  login(page?: 'authorize' | 'forgotPassword'): Promise<void>;
  /** If the URL carries ?code=, completes the exchange. Returns true if a callback was handled. */
  handleCallback(): Promise<boolean>;
  isAuthenticated(): boolean;
  getToken(): Promise<string>;
  logout(): void;
}

const TOKENS_KEY = 'homecloud.tokens';
const PKCE_KEY = 'homecloud.pkce';
const REFRESH_SKEW_MS = 60_000;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export function normalizeDomain(d: string): string {
  return (/^https?:\/\//.test(d) ? d : `https://${d}`).replace(/\/+$/, '');
}

export function defaultRedirectUri(): string {
  return window.location.origin + window.location.pathname;
}

/** Decodes the `exp` claim (seconds) of a JWT; returns ms or undefined. Never logs. */
export function jwtExpiryMs(jwt: string): number | undefined {
  try {
    const part = jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const exp = JSON.parse(atob(part)).exp;
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function createAuth(cfg: AuthConfig): Auth {
  const domain = normalizeDomain(cfg.cognitoDomain);
  const redirectUri = () => cfg.redirectUri || defaultRedirectUri();
  const scope = cfg.scope ?? 'openid email profile';
  let refreshing: Promise<StoredTokens> | null = null;

  const load = (): StoredTokens | null => {
    try {
      const raw = sessionStorage.getItem(TOKENS_KEY);
      return raw ? (JSON.parse(raw) as StoredTokens) : null;
    } catch {
      return null;
    }
  };
  const save = (t: StoredTokens) => sessionStorage.setItem(TOKENS_KEY, JSON.stringify(t));
  const clear = () => {
    sessionStorage.removeItem(TOKENS_KEY);
    sessionStorage.removeItem(PKCE_KEY);
  };

  async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetch(`${domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, ...params }),
    });
    let body: Record<string, unknown> = {};
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    if (!res.ok) {
      const code = typeof body.error === 'string' ? body.error : `http_${res.status}`;
      throw new AuthError(`token endpoint error: ${code}`);
    }
    return body;
  }

  function toStored(body: Record<string, unknown>, prev?: StoredTokens | null): StoredTokens {
    const idToken = String(body.id_token ?? prev?.idToken ?? '');
    const accessToken = String(body.access_token ?? '');
    if (!idToken || !accessToken) throw new AuthError('token response missing tokens');
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in * 1000 : undefined;
    return {
      idToken,
      accessToken,
      // Cognito does not return a new refresh_token on refresh; keep the old one.
      refreshToken: (body.refresh_token as string | undefined) ?? prev?.refreshToken,
      expiresAt: jwtExpiryMs(accessToken) ?? Date.now() + (expiresIn ?? 3600_000),
    };
  }

  return {
    async login(page = 'authorize') {
      const verifier = generateVerifier();
      const state = randomState();
      sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: cfg.clientId,
        redirect_uri: redirectUri(),
        scope,
        state,
        code_challenge_method: 'S256',
        code_challenge: await challengeS256(verifier),
      });
      window.location.assign(`${domain}/${page === 'forgotPassword' ? 'forgotPassword' : 'oauth2/authorize'}?${q}`);
    },

    async handleCallback() {
      const url = new URL(window.location.href);
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      if (!code && !err) return false;
      const stripUrl = () => window.history.replaceState({}, '', window.location.pathname);
      const raw = sessionStorage.getItem(PKCE_KEY);
      sessionStorage.removeItem(PKCE_KEY);
      stripUrl();
      if (err) throw new AuthError(`login failed: ${url.searchParams.get('error_description') || err}`);
      let saved: { verifier: string; state: string } | null = null;
      try {
        saved = raw ? JSON.parse(raw) : null;
      } catch {
        /* ignore */
      }
      if (!saved || saved.state !== url.searchParams.get('state')) {
        throw new AuthError('login failed: state mismatch (try signing in again)');
      }
      const body = await tokenRequest({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: redirectUri(),
        code_verifier: saved.verifier,
      });
      save(toStored(body));
      return true;
    },

    isAuthenticated() {
      const t = load();
      return !!t && (t.expiresAt > Date.now() || !!t.refreshToken);
    },

    async getToken() {
      let t = load();
      if (!t) throw new AuthError('not signed in');
      if (t.expiresAt - REFRESH_SKEW_MS <= Date.now()) {
        if (!t.refreshToken) {
          clear();
          throw new AuthError('session expired');
        }
        const prev = t;
        refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: prev.refreshToken! })
          .then((b) => {
            const next = toStored(b, prev);
            save(next);
            return next;
          })
          .catch((e) => {
            clear();
            throw e;
          })
          .finally(() => {
            refreshing = null;
          });
        t = await refreshing;
      }
      return cfg.tokenType === 'access' ? t.accessToken : t.idToken;
    },

    logout() {
      clear();
      const q = new URLSearchParams({ client_id: cfg.clientId, logout_uri: redirectUri() });
      window.location.assign(`${domain}/logout?${q}`);
    },
  };
}

