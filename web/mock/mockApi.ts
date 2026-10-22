import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

interface E {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
}

const now = () => new Date().toISOString();
const e = (entity_id: string, state: string, attributes: Record<string, unknown> = {}): E => ({
  entity_id,
  state,
  attributes: { friendly_name: entity_id.split('.')[1]!.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), ...attributes },
  last_changed: now(),
});

/** Dev-only fake of the homecloud HTTP API (docs/contract.md). Run with `npm run dev:mock`. */
export function mockApiPlugin(): Plugin {
  const homes: Record<string, { online: boolean; lastSeenTs: number; entities: Map<string, E> }> = {
    'main-house': {
      online: true,
      lastSeenTs: Date.now(),
      entities: new Map(
        [
          e('light.kitchen', 'on', { brightness: 180, supported_color_modes: ['brightness'] }),
          e('light.living_room', 'off', { brightness: 120, supported_color_modes: ['brightness'] }),
          e('light.hallway', 'on', { supported_color_modes: ['onoff'] }),
          e('light.flaky_bulb', 'off', { friendly_name: 'Flaky bulb (always fails)', supported_color_modes: ['onoff'] }),
          e('switch.coffee_maker', 'off'),
          e('switch.garden_pump', 'on'),
          e('fan.bedroom', 'off', { percentage: 0 }),
          e('climate.thermostat', 'heat', { temperature: 21, current_temperature: 19.5, hvac_action: 'heating', temperature_unit: '°C', target_temp_step: 0.5, unit_of_measurement: '°C' }),
          e('cover.garage_door', 'closed'),
          e('cover.living_blinds', 'open'),
          e('scene.movie_night', 'scening'),
          e('scene.good_morning', 'scening'),
          e('sensor.outdoor_temperature', '12.4', { unit_of_measurement: '°C', device_class: 'temperature' }),
          e('sensor.living_room_humidity', '48', { unit_of_measurement: '%', device_class: 'humidity' }),
          e('sensor.power_usage', '412', { unit_of_measurement: 'W' }),
          e('binary_sensor.front_door', 'off', { device_class: 'door' }),
          e('sun.sun', 'above_horizon', { friendly_name: 'Sun', homecloud_latitude: 43.65, homecloud_longitude: -79.38 }),
          { ...e('binary_sensor.back_door', 'on', { device_class: 'door', friendly_name: 'Back door' }), last_changed: new Date(Date.now() - 20 * 60_000).toISOString() },
          e('sensor.nas_drive_1_temperature', '54', { device_class: 'temperature', unit_of_measurement: '°C', friendly_name: 'NAS (Drive 1) Temperature' }),
          e('sensor.nas_drive_2_temperature', '38', { device_class: 'temperature', unit_of_measurement: '°C', friendly_name: 'NAS (Drive 2) Temperature' }),
          e('binary_sensor.motion_hall', 'on', { device_class: 'motion' }),
        ].map((x) => [x.entity_id, x]),
      ),
    },
    cabin: { online: false, lastSeenTs: Date.now() - 3 * 3600_000, entities: new Map([[ 'light.porch', e('light.porch', 'off', { supported_color_modes: ['onoff'] }) ]]) },
  };
  const commands = new Map<string, { status: 'pending' | 'ok' | 'error'; error: string | null }>();
  let seq = 0;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => resolve(b));
    });

  function apply(home: (typeof homes)[string], cmd: any): string | null {
    const id = Array.isArray(cmd.target?.entity_id) ? cmd.target.entity_id[0] : cmd.target?.entity_id;
    const ent = home.entities.get(id);
    if (!ent) return 'bad_request: unknown entity';
    if (id === 'light.flaky_bulb') return 'ha_error: device unreachable';
    const { domain, service, data = {} } = cmd;
    if (service === 'turn_on') {
      ent.state = 'on';
      if (typeof data.brightness === 'number') ent.attributes.brightness = data.brightness;
    } else if (service === 'turn_off') ent.state = 'off';
    else if (service === 'open_cover') ent.state = 'open';
    else if (service === 'close_cover') ent.state = 'closed';
    else if (domain === 'climate' && service === 'set_temperature') ent.attributes.temperature = data.temperature;
    else if (domain === 'scene') return null;
    else return 'not_allowed: ' + domain + '.' + service;
    ent.last_changed = now();
    return null;
  }

  return {
    name: 'homecloud-mock-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const p = url.pathname;
        if (p === '/config.json') return send(res, 200, { apiUrl: '', mock: true });
        if (!p.startsWith('/v1/')) return next();
        await new Promise((r) => setTimeout(r, 120)); // feel like a network
        let m: RegExpMatchArray | null;
        if (p === '/v1/health') return send(res, 200, { ok: true, version: 'mock' });
        if (p === '/v1/homes') {
          homes['main-house']!.lastSeenTs = Date.now();
          return send(res, 200, { homes: Object.entries(homes).map(([homeId, h]) => ({ homeId, online: h.online, lastSeenTs: h.lastSeenTs })) });
        }
        if ((m = p.match(/^\/v1\/homes\/([^/]+)\/entities$/))) {
          const h = homes[decodeURIComponent(m[1]!)];
          if (!h) return send(res, 404, { error: 'not_found', message: 'no such home' });
          const jitter = (x: E) =>
            x.entity_id === 'sensor.power_usage' ? { ...x, state: String(380 + Math.round(Math.random() * 80)) } : x;
          let list = [...h.entities.values()].map(jitter);
          const d = url.searchParams.get('domain');
          if (d) list = list.filter((x) => x.entity_id.startsWith(d + '.'));
          return send(res, 200, { entities: list, updatedTs: Date.now() });
        }
        if ((m = p.match(/^\/v1\/homes\/([^/]+)\/entities\/([^/]+)$/))) {
          const ent = homes[decodeURIComponent(m[1]!)]?.entities.get(decodeURIComponent(m[2]!));
          return ent ? send(res, 200, ent) : send(res, 404, { error: 'not_found', message: 'no such entity' });
        }
        if ((m = p.match(/^\/v1\/homes\/([^/]+)\/commands$/)) && req.method === 'POST') {
          const h = homes[decodeURIComponent(m[1]!)];
          if (!h) return send(res, 404, { error: 'not_found', message: 'no such home' });
          let cmd: any;
          try {
            cmd = JSON.parse(await readBody(req));
          } catch {
            return send(res, 400, { error: 'bad_request', message: 'invalid JSON' });
          }
          const id = `c_mock${++seq}`;
          commands.set(id, { status: 'pending', error: null });
          setTimeout(() => commands.set(id, h.online ? (() => { const err = apply(h, cmd); return { status: err ? 'error' : 'ok', error: err } as const; })() : { status: 'error', error: 'ha_error: home offline' }), 700);
          return send(res, 202, { id, status: 'pending' });
        }
        if ((m = p.match(/^\/v1\/homes\/([^/]+)\/commands\/([^/]+)$/))) {
          const c = commands.get(decodeURIComponent(m[2]!));
          return c ? send(res, 200, { id: decodeURIComponent(m[2]!), ...c }) : send(res, 404, { error: 'not_found', message: 'no such command' });
        }
        return send(res, 404, { error: 'not_found', message: 'no such route' });
      });
    },
  };
}
