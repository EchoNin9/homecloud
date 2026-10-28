import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { kelvinToRgb } from '../src/components/color';

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
          e('light.reading_lamp', 'on', { brightness: 200, supported_color_modes: ['color_temp', 'hs'], color_mode: 'hs', rgb_color: [255, 96, 64], min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500, homecloud_area: 'Living room' }),
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
          e('update.wud_container_local_homecloud_adguard_1', 'on', { title: 'homecloud-adguard-1', installed_version: 'v0.107.79', latest_version: 'v0.107.80' }),
          e('update.wud_container_local_homecloud_homeassistant_1', 'on', { title: 'homecloud-homeassistant-1', installed_version: 'stable', latest_version: 'sha256:21935614aa' }),
          e('update.nas2_dsm_update', 'on', { friendly_name: 'NAS2 DSM update', installed_version: 'DSM 7.4.1-90080', latest_version: 'DSM 7.4.1-90080 Update 1' }),
          e('update.wud_container_local_homecloud_mosquitto_1', 'off', { title: 'homecloud-mosquitto-1', installed_version: '2', latest_version: '2' }),
          e('sun.sun', 'above_horizon', { friendly_name: 'Sun', homecloud_latitude: 43.65, homecloud_longitude: -79.38 }),
          { ...e('binary_sensor.back_door', 'on', { device_class: 'door', friendly_name: 'Back door' }), last_changed: new Date(Date.now() - 20 * 60_000).toISOString() },
          e('sensor.nas_drive_1_temperature', '54', { device_class: 'temperature', unit_of_measurement: '°C', friendly_name: 'NAS (Drive 1) Temperature' }),
          e('sensor.nas_drive_2_temperature', '38', { device_class: 'temperature', unit_of_measurement: '°C', friendly_name: 'NAS (Drive 2) Temperature' }),
          e('binary_sensor.motion_hall', 'on', { device_class: 'motion' }),
          e('sensor.nas2_drive_7_temperature', '44', { device_class: 'temperature', unit_of_measurement: '°C', friendly_name: 'NAS2 (Drive 7) Temperature' }),
          e('sensor.docker_homecloud_bridge_1', 'running', { friendly_name: 'homecloud-bridge-1', icon: 'mdi:docker', image: 'homecloud-bridge:0.1.0', health: null }),
          e('switch.kitchen_tv_do_not_disturb', 'off', { friendly_name: 'Kitchen TV yes Do not disturb' }),
          e('light.desk', 'on', { friendly_name: 'Desk Light', brightness: 125, supported_color_modes: ['brightness'], homecloud_area: 'Office' }),
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
  const prefsStore: Record<string, { prefs: unknown; updatedTs: number }> = {};
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
      // Like HA: setting one colour mode clears the other, and rgb_color always reflects the output.
      if (Array.isArray(data.rgb_color)) Object.assign(ent.attributes, { rgb_color: data.rgb_color, color_mode: 'hs', color_temp_kelvin: null });
      if (typeof data.color_temp_kelvin === 'number') Object.assign(ent.attributes, { color_temp_kelvin: data.color_temp_kelvin, color_mode: 'color_temp', rgb_color: kelvinToRgb(data.color_temp_kelvin) });
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
          return send(res, 200, { entities: list, updatedTs: Date.now(), historyEntities: ['sensor.*_drive_*_temperature', 'light.*', 'sun.sun', 'binary_sensor.*door*'] });
        }
        if ((m = p.match(/^\/v1\/homes\/([^/]+)\/history\/([^/]+)$/))) {
          // Synthetic history. light.porch, binary_sensor.front_door and anything with "2" in the id are empty (first-deploy case).
          const id = decodeURIComponent(m[2]!);
          const res2 = url.searchParams.get('res') ?? 'raw';
          const to = Number(url.searchParams.get('to') ?? Date.now());
          const from = Number(url.searchParams.get('from') ?? to - 86_400_000);
          const empty = /porch|front_door|2/.test(id);
          const numeric = id.startsWith('sensor.');
          const H = 3_600_000;
          const base = { entityId: id, res: res2, from, to, prev: null as unknown };
          if (empty) return send(res, 200, { ...base, points: [] });
          if (res2 === 'day') {
            const points = [];
            for (let t = from; t <= to; t += 24 * H) {
              const date = new Date(t).toISOString().slice(0, 10);
              const k = Math.sin(t / (9e8));
              points.push(numeric ? { date, min: 36 + 3 * k, max: 48 + 4 * k, avg: 42 + 3 * k, n: 40 } : { date, dur: id === 'sun.sun' ? { above_horizon: (12 + 3 * k) * 3600, below_horizon: (12 - 3 * k) * 3600 } : { on: (4 + 2 * k) * 3600, off: (20 - 2 * k) * 3600 }, n: 4 });
            }
            return send(res, 200, { ...base, points: points.slice(-30 * 16) });
          }
          const step = numeric ? H / 2 : 3 * H;
          const pts = [];
          for (let t = from + step, i = 0; t < to; t += step, i++) pts.push({ t: new Date(t).toISOString(), state: numeric ? String(Math.round(40 + 6 * Math.sin(t / 2e7))) : i % 2 ? 'off' : 'on' });
          return send(res, 200, { ...base, prev: { t: new Date(from - H).toISOString(), state: numeric ? '41' : 'off' }, points: pts });
        }
        if ((m = p.match(/^\/v1\/homes\/([^/]+)\/entities\/([^/]+)$/))) {
          const ent = homes[decodeURIComponent(m[1]!)]?.entities.get(decodeURIComponent(m[2]!));
          return ent ? send(res, 200, ent) : send(res, 404, { error: 'not_found', message: 'no such entity' });
        }
        if ((m = p.match(/^\/v1\/homes\/([^/]+)\/prefs$/))) {
          // ponytail: one in-memory user; restarting the dev server clears it.
          const k = decodeURIComponent(m[1]!);
          if (req.method === 'PUT') {
            prefsStore[k] = { prefs: JSON.parse(await readBody(req)).prefs, updatedTs: Date.now() };
            return send(res, 200, { updatedTs: prefsStore[k].updatedTs });
          }
          return send(res, 200, prefsStore[k] ?? { prefs: null, updatedTs: null });
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
