import { useEffect, useMemo, useState } from 'react';
import { createAuth, type Auth } from './auth';
import { HomeCloudClient } from './client';
import { HomeCloudDashboard } from './components';
import { loadConfig, type AppConfig } from './config';
import './app.css';

type Phase =
  | { t: 'loading' }
  | { t: 'no-config'; reason: string }
  | { t: 'auth-error'; reason: string }
  | { t: 'signed-out' }
  | { t: 'ready' };

export interface AppProps {
  /** Embedding hook: supply tokens from a host app's existing Cognito session instead of the built-in login. */
  getToken?: () => Promise<string>;
}

export function App({ getToken: externalGetToken }: AppProps) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [phase, setPhase] = useState<Phase>({ t: 'loading' });

  const auth: Auth | null = useMemo(
    () =>
      cfg && !cfg.mock && !externalGetToken
        ? createAuth({ clientId: cfg.clientId!, cognitoDomain: cfg.cognitoDomain!, redirectUri: cfg.redirectUri })
        : null,
    [cfg, externalGetToken],
  );

  useEffect(() => {
    let cancelled = false;
    loadConfig()
      .then((c) => !cancelled && setCfg(c))
      .catch((e: Error) => !cancelled && setPhase({ t: 'no-config', reason: e.message }));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!cfg) return;
    if (!auth) return setPhase({ t: 'ready' });
    let cancelled = false;
    auth
      .handleCallback()
      .then(() => !cancelled && setPhase(auth.isAuthenticated() ? { t: 'ready' } : { t: 'signed-out' }))
      .catch((e: Error) => !cancelled && setPhase({ t: 'auth-error', reason: e.message }));
    return () => {
      cancelled = true;
    };
  }, [cfg, auth]);

  const client = useMemo(
    () =>
      cfg
        ? new HomeCloudClient({
            apiUrl: cfg.apiUrl,
            getToken: externalGetToken ?? (auth ? () => auth.getToken() : async () => 'mock'),
          })
        : null,
    [cfg, auth, externalGetToken],
  );

  switch (phase.t) {
    case 'loading':
      return <main className="app-center"><p role="status">Loading…</p></main>;
    case 'no-config':
      return (
        <main className="app-center">
          <h1>homecloud isn't configured</h1>
          <p>The app couldn't load a valid <code>/config.json</code>: {phase.reason}.</p>
          <p>
            Copy <code>config.example.json</code> to <code>config.json</code> next to <code>index.html</code> and fill in your
            values (the Terraform module writes this file for you), or run <code>npm run dev:mock</code> to try the UI with fake data.
          </p>
        </main>
      );
    case 'auth-error':
      return (
        <main className="app-center">
          <h1>Sign-in problem</h1>
          <p>{phase.reason}</p>
          <button type="button" className="app-btn" onClick={() => auth?.login()}>Try again</button>
        </main>
      );
    case 'signed-out':
      return (
        <main className="app-center">
          <h1>homecloud</h1>
          <p>Sign in to see your homes.</p>
          <button type="button" className="app-btn" onClick={() => auth?.login()}>Sign in</button>
          <button type="button" className="app-link" onClick={() => auth?.login('forgotPassword')}>Forgot password?</button>
        </main>
      );
    case 'ready':
      return (
        <>
          {auth && (
            <div className="app-bar">
              <span>homecloud</span>
              <button type="button" className="app-link" onClick={() => auth.logout()}>Sign out</button>
            </div>
          )}
          {client && <HomeCloudDashboard client={client} />}
        </>
      );
  }
}
