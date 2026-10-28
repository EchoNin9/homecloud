import { HomeCloudError } from './errors';
import type {
  CommandAccepted,
  CommandRequest,
  CommandStatus,
  Entity,
  EntityList,
  Health,
  Home,
  HomeCloudClientOptions,
  ListEntitiesOptions,
  WaitForCommandOptions,
  History,
  HistoryOptions,
  PrefsResponse,
} from './types';

const enc = encodeURIComponent;

export class HomeCloudClient {
  private readonly base: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HomeCloudClientOptions) {
    this.base = opts.apiUrl.replace(/\/+$/, '');
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  health(): Promise<Health> {
    return this.request<Health>('GET', '/v1/health', undefined, false);
  }

  async listHomes(): Promise<Home[]> {
    const r = await this.request<{ homes: Home[] }>('GET', '/v1/homes');
    return r.homes;
  }

  listEntities(homeId: string, opts: ListEntitiesOptions = {}): Promise<EntityList> {
    const q = opts.domain ? `?domain=${enc(opts.domain)}` : '';
    return this.request<EntityList>('GET', `/v1/homes/${enc(homeId)}/entities${q}`);
  }

  getEntity(homeId: string, entityId: string): Promise<Entity> {
    return this.request<Entity>('GET', `/v1/homes/${enc(homeId)}/entities/${enc(entityId)}`);
  }

  getHistory(homeId: string, entityId: string, opts: HistoryOptions = {}): Promise<History> {
    // No URLSearchParams: React Native's implementation is incomplete and this client is shared with the app.
    const qs = (['res', 'from', 'to'] as const)
      .filter((k) => opts[k] !== undefined)
      .map((k) => `${k}=${enc(String(opts[k]))}`)
      .join('&');
    return this.request<History>('GET', `/v1/homes/${enc(homeId)}/history/${enc(entityId)}${qs ? `?${qs}` : ''}`);
  }

  sendCommand(homeId: string, cmd: CommandRequest): Promise<CommandAccepted> {
    return this.request<CommandAccepted>('POST', `/v1/homes/${enc(homeId)}/commands`, cmd);
  }

  getCommand(homeId: string, id: string): Promise<CommandStatus> {
    return this.request<CommandStatus>('GET', `/v1/homes/${enc(homeId)}/commands/${enc(id)}`);
  }

  getPrefs<P = Record<string, unknown>>(homeId: string): Promise<PrefsResponse<P>> {
    return this.request<PrefsResponse<P>>('GET', `/v1/homes/${enc(homeId)}/prefs`);
  }

  putPrefs(homeId: string, prefs: object): Promise<{ updatedTs: number }> {
    return this.request<{ updatedTs: number }>('PUT', `/v1/homes/${enc(homeId)}/prefs`, { prefs });
  }

  /**
   * Polls until the command leaves `pending`. Resolves with the final status
   * (`ok` or `error`; inspect `.status`/`.error`). Rejects with
   * HomeCloudError(code "timeout") if still pending after timeoutMs.
   */
  async waitForCommand(
    homeId: string,
    id: string,
    { timeoutMs = 10000, intervalMs = 500 }: WaitForCommandOptions = {},
  ): Promise<CommandStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.getCommand(homeId, id);
      if (s.status === 'ok' || s.status === 'error') return s;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new HomeCloudError(0, 'timeout', `command ${id} still pending after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    auth = true,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (auth) headers.Authorization = `Bearer ${await this.getToken()}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new HomeCloudError(0, 'network_error', e instanceof Error ? e.message : 'network error');
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!res.ok) {
      const j = (json && typeof json === 'object' ? json : {}) as { error?: unknown; message?: unknown };
      const code = typeof j.error === 'string' ? j.error : `http_${res.status}`;
      const message = typeof j.message === 'string' ? j.message : undefined;
      throw new HomeCloudError(res.status, code, message ?? `${method} ${path} failed (${res.status})`);
    }
    if (json === undefined) throw new HomeCloudError(res.status, 'bad_response', 'response was not JSON');
    return json as T;
  }
}
