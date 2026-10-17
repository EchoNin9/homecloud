export interface AppConfig {
  apiUrl: string;
  region?: string;
  userPoolId?: string;
  clientId?: string;
  cognitoDomain?: string;
  redirectUri?: string;
  /** Set only by the dev mock server: skip Cognito entirely. */
  mock?: boolean;
}

export async function loadConfig(url = '/config.json'): Promise<AppConfig> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  let cfg: unknown;
  try {
    cfg = await res.json();
  } catch {
    throw new Error(`${url} is not valid JSON${ct.includes('html') ? ' (got an HTML page, so the file is missing)' : ''}`);
  }
  const c = cfg as Partial<AppConfig>;
  if (typeof c.apiUrl !== 'string') throw new Error('config.json is missing "apiUrl"');
  if (!c.mock && (!c.clientId || !c.cognitoDomain)) {
    throw new Error('config.json is missing "clientId" and/or "cognitoDomain"');
  }
  return c as AppConfig;
}
