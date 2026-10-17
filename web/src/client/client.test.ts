import { describe, expect, it, vi } from 'vitest';
import { HomeCloudClient, HomeCloudError } from './index';

type Call = { url: string; init: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responder(url, init);
  });
  const getToken = vi.fn(async () => 'tok123');
  const client = new HomeCloudClient({
    apiUrl: 'https://api.example.com/',
    getToken,
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, calls, getToken };
}

const hdr = (c: Call, k: string) => (c.init.headers as Record<string, string>)[k];

describe('URL building and headers', () => {
  it('health: correct URL, no auth header, token not requested', async () => {
    const { client, calls, getToken } = setup(() => json({ ok: true, version: '1' }));
    expect(await client.health()).toEqual({ ok: true, version: '1' });
    expect(calls[0]!.url).toBe('https://api.example.com/v1/health');
    expect(hdr(calls[0]!, 'Authorization')).toBeUndefined();
    expect(getToken).not.toHaveBeenCalled();
  });

  it('listHomes unwraps homes and sends bearer token', async () => {
    const { client, calls } = setup(() => json({ homes: [{ homeId: 'h1', online: true, lastSeenTs: 5 }] }));
    expect(await client.listHomes()).toEqual([{ homeId: 'h1', online: true, lastSeenTs: 5 }]);
    expect(calls[0]!.url).toBe('https://api.example.com/v1/homes');
    expect(hdr(calls[0]!, 'Authorization')).toBe('Bearer tok123');
  });

  it('listEntities encodes homeId and domain query', async () => {
    const { client, calls } = setup(() => json({ entities: [], updatedTs: 1 }));
    await client.listEntities('my-home', { domain: 'light' });
    await client.listEntities('my-home');
    await client.listEntities('a b', { domain: 'x&y' });
    expect(calls[0]!.url).toBe('https://api.example.com/v1/homes/my-home/entities?domain=light');
    expect(calls[1]!.url).toBe('https://api.example.com/v1/homes/my-home/entities');
    expect(calls[2]!.url).toBe('https://api.example.com/v1/homes/a%20b/entities?domain=x%26y');
  });

  it('getEntity percent-encodes the entity id as a single segment', async () => {
    const { client, calls } = setup(() => json({ entity_id: 'x', state: 'on', attributes: {}, last_changed: '' }));
    await client.getEntity('h', 'light.kitchen/../admin?x=1#f');
    expect(calls[0]!.url).toBe(
      'https://api.example.com/v1/homes/h/entities/light.kitchen%2F..%2Fadmin%3Fx%3D1%23f',
    );
  });

  it('sendCommand POSTs JSON body', async () => {
    const { client, calls } = setup(() => json({ id: 'c_1', status: 'pending' }, 202));
    const cmd = { domain: 'light', service: 'turn_on', target: { entity_id: 'light.k' }, data: { brightness: 200 } };
    expect(await client.sendCommand('h', cmd)).toEqual({ id: 'c_1', status: 'pending' });
    expect(calls[0]!.url).toBe('https://api.example.com/v1/homes/h/commands');
    expect(calls[0]!.init.method).toBe('POST');
    expect(hdr(calls[0]!, 'Content-Type')).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(cmd);
  });

  it('getCommand encodes the id', async () => {
    const { client, calls } = setup(() => json({ id: 'c/1', status: 'pending', error: null }));
    await client.getCommand('h', 'c/1');
    expect(calls[0]!.url).toBe('https://api.example.com/v1/homes/h/commands/c%2F1');
  });
});

describe('error mapping', () => {
  it('maps {error,message} bodies to HomeCloudError', async () => {
    const { client } = setup(() => json({ error: 'forbidden', message: 'not in group' }, 403));
    const err = await client.listHomes().catch((e) => e);
    expect(err).toBeInstanceOf(HomeCloudError);
    expect(err).toMatchObject({ status: 403, code: 'forbidden', message: 'not in group' });
  });

  it('falls back to http_<status> for non-contract bodies', async () => {
    const { client } = setup(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const err = await client.listHomes().catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: 'http_502' });
  });

  it('maps 404 on getEntity', async () => {
    const { client } = setup(() => json({ error: 'not_found', message: 'no such entity' }, 404));
    await expect(client.getEntity('h', 'light.x')).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('maps network failures to status 0 / network_error', async () => {
    const { client } = setup(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(client.listHomes()).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('flags a 200 with a non-JSON body as bad_response', async () => {
    const { client } = setup(() => new Response('nope', { status: 200 }));
    await expect(client.listHomes()).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('waitForCommand', () => {
  const seq = (...statuses: Array<[string, string | null]>) => {
    let i = 0;
    return () => {
      const [status, error] = statuses[Math.min(i++, statuses.length - 1)]!;
      return json({ id: 'c1', status, error });
    };
  };

  it('resolves when status becomes ok', async () => {
    const { client, calls } = setup(seq(['pending', null], ['pending', null], ['ok', null]));
    const r = await client.waitForCommand('h', 'c1', { intervalMs: 1, timeoutMs: 1000 });
    expect(r.status).toBe('ok');
    expect(calls).toHaveLength(3);
  });

  it('resolves (not throws) with error status and code', async () => {
    const { client } = setup(seq(['pending', null], ['error', 'not_allowed: nope']));
    const r = await client.waitForCommand('h', 'c1', { intervalMs: 1, timeoutMs: 1000 });
    expect(r).toMatchObject({ status: 'error', error: 'not_allowed: nope' });
  });

  it('rejects with timeout when it stays pending', async () => {
    const { client, calls } = setup(seq(['pending', null]));
    const err = await client.waitForCommand('h', 'c1', { intervalMs: 5, timeoutMs: 40 }).catch((e) => e);
    expect(err).toBeInstanceOf(HomeCloudError);
    expect(err).toMatchObject({ code: 'timeout' });
    expect(calls.length).toBeGreaterThan(1);
  });

  it('propagates HTTP errors while polling', async () => {
    const { client } = setup(() => json({ error: 'not_found', message: 'x' }, 404));
    await expect(client.waitForCommand('h', 'c1', { intervalMs: 1 })).rejects.toMatchObject({ status: 404 });
  });
});
