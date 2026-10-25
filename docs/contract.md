# homecloud contract (v1)

The single source of truth shared by the three parts. Change this file first,
then the code.

```
 NAS (Synology, Docker)                       AWS (Terraform module)                  Clients
 ┌──────────────┐  ws   ┌────────┐  MQTT/TLS  ┌──────────┐ rule ┌─────────┐ ┌──────┐   ┌──────────┐
 │Home Assistant│◄─────►│ bridge │◄──────────►│ IoT Core │─────►│ ingest λ│►│Dynamo│◄──│  api λ   │◄─ web / any app
 └──────────────┘       └────────┘ (outbound) └──────────┘      └─────────┘ └──────┘   └──────────┘   (Cognito JWT)
                                                   ▲                                       │ iot:Publish cmd
                                                   └───────────────────────────────────────┘
```

- The NAS only makes **outbound** connections. No ports are opened at home.
- Home Assistant keeps working if AWS or the internet is down.
- `homeId`: `^[a-z0-9-]{1,32}$`. One IoT Thing per home, named `{prefix}-{homeId}`.
  The MQTT client id must equal the Thing name.

## MQTT topics

Prefix `homecloud/{homeId}/`. The IoT policy limits a home's certificate to its own prefix.

| Topic | Direction | Payload |
|---|---|---|
| `homecloud/{homeId}/state` | bridge → cloud | `StateBatch` |
| `homecloud/{homeId}/cmd` | cloud → bridge | `Command` |
| `homecloud/{homeId}/cmd/ack` | bridge → cloud | `CommandAck` |
| `homecloud/{homeId}/status` | bridge → cloud | `{"online": bool, "ts": int, "version": str}` (also the LWT, retained=false, with `online:false`) |

All `ts` values are Unix epoch **milliseconds** (integer). Payloads are JSON, max 128 KB
(IoT Core's limit). The bridge splits a large snapshot into several batches.

### StateBatch
```json
{
  "v": 1,
  "ts": 1760000000000,
  "snapshot": false,
  "entities": [
    {
      "entity_id": "light.kitchen",
      "state": "on",
      "attributes": {"brightness": 180, "friendly_name": "Kitchen"},
      "last_changed": "2026-10-17T12:00:00.000000+00:00"
    }
  ],
  "removed": ["light.old_lamp"]
}
```
`removed` is optional. It lists entity ids that HA deleted (`new_state: null`). The cloud
deletes those ENTITY items. Known v1 limitation: if you narrow the bridge filter, the newly
excluded entities stay in the cloud until they are deleted by hand.

**Ordering:** the cloud writes an ENTITY item only when the incoming `last_changed` is greater
than or equal to the stored one. It uses a conditional write, so a late delta never overwrites
a newer snapshot.

`snapshot: true` means a full resend after connect. The bridge sends one on every
(re)connect and every 15 minutes. Attributes are passed through as-is, minus anything
over 4 KB per entity. Only entities allowed by the bridge's domain/entity filter are sent.

The bridge adds one attribute of its own: `homecloud_area` (string), the name of the HA area
the entity is in (its own area, else its device's). It is omitted when there is no area, and
it is added after the 4 KB cap, so the cap never drops it. Areas are re-read at each snapshot, so
a change in HA shows up within 15 minutes. Clients must treat it as optional.

On `sun.sun` only, the bridge also adds `homecloud_latitude` and `homecloud_longitude` (numbers,
HA's configured home location) so clients can compute today's sunrise and sunset. HA itself only
reports the next ones. Optional: without them, clients fall back to `next_rising` / `next_setting`.

### Command
```json
{
  "v": 1,
  "id": "c_01J...",
  "ts": 1760000000000,
  "domain": "light",
  "service": "turn_on",
  "target": {"entity_id": "light.kitchen"},
  "data": {"brightness": 200}
}
```
The bridge **must reject** a command when any of these hold:
- `v` is not 1
- `ts` is more than 60 s old or more than 10 s in the future
- the `id` has already been seen (bridge keeps the last 1000 ids)
- `domain.service` is not in `BRIDGE_ALLOWED_SERVICES`
- the target entity is not in the exported filter

### CommandAck
```json
{"v": 1, "id": "c_01J...", "ts": 1760000000500, "ok": true, "error": null}
```
`error` is a short code: `stale`, `duplicate`, `not_allowed`, `bad_request` or `ha_error`,
optionally followed by `: <message>`.

## DynamoDB (single table `{prefix}-state`)

| PK | SK | Attributes |
|---|---|---|
| `HOME#{homeId}` | `ENTITY#{entity_id}` | `state`, `attributes` (map), `last_changed`, `updated_ts` |
| `HOME#{homeId}` | `META` | `online`, `last_seen_ts`, `bridge_version` |
| `HOME#{homeId}` | `CMD#{id}` | `status` (`pending`/`ok`/`error`), `error`, `created_ts`, `acked_ts`, `requested_by`, `ttl` (7 days) |

Floats must be converted with `Decimal(str(v))` at the single write path, because boto3
rejects Python floats.

### History (tracked entities only)

An entity is tracked when its id matches one of the module's `history_entities` globs.

| PK | SK | Attributes |
|---|---|---|
| `HIST#{homeId}#{entity_id}` | `R#{last_changed}` | `state`, `ttl` (35 days). Written by ingest for each accepted state |
| `HIST#{homeId}#{entity_id}` | `D#{YYYY-MM-DD}` | Numeric: `min`, `max`, `avg` (time-weighted). Otherwise: `dur` (map of state → seconds). Both have `n` (changes that day) and `ttl` (15 months) |

- `R#` items are keyed by `last_changed`, so attribute-only updates rewrite the same item.
- A daily rollup job writes `D#` items for each of the last 3 **UTC** days. A missed run
  heals on the next one.
- A day's rollup opens with the last raw state from before midnight (or the `ENTITY#` item
  if no raw state is older). History starts when this is first deployed.
- Backups: the table's PITR (35 days). AWS Backup comes later.

Examples: `sun.sun` `dur.above_horizon` is the daylight length. A light's
`dur.on` is its on-time. The `R#` keys of `sun.sun` are the sunrise and sunset times.
Container states (see below) give uptime.

### NAS container sensors

A sidecar on the NAS (`nas/docker-compose.yml` `monitor`) sets `sensor.docker_{name}` in
Home Assistant every 60 s. The `state` is Docker's `State` (`running`, `exited`,
`restarting`, …). Attributes: `image`, `started_at` (ISO), `health` (`healthy`,
`unhealthy`, `starting` or `null`), `icon`.

The NAS update checker (What's Up Docker, `wud` service) publishes `update.wud_container_local_{container}`
through HA's MQTT discovery. The `state` is `on` when a newer image exists. Attributes: `title` (the
container name), `installed_version` (tag), `latest_version` (a tag, or `sha256:…` when the same tag
has a new image), `release_url`. **Notify only:** `update.install` is never in a service allowlist.
These are ordinary entities to the bridge and the cloud.

## HTTP API (`/v1`, Cognito JWT on every route except `/v1/health`)

| Method + path | Response |
|---|---|
| `GET /v1/health` | `{"ok": true, "version": "..."}` (no auth) |
| `GET /v1/homes` | `{"homes": [{"homeId","online","lastSeenTs"}]}` |
| `GET /v1/homes/{homeId}/entities?domain=light` | `{"entities": [Entity], "updatedTs"}` |
| `GET /v1/homes/{homeId}/entities/{entityId}` | `Entity`, or 404 |
| `POST /v1/homes/{homeId}/commands` body `{domain, service, target, data?}` | `202 {"id","status":"pending"}` |
| `GET /v1/homes/{homeId}/commands/{id}` | `{"id","status","error"}` |

Authorization: the caller's `cognito:groups` claim must intersect the module's
`allowed_groups` (default `["admin"]`), or the API returns 403. The API also checks the
service allowlist server-side (`allowed_services`) before publishing, so the bridge's
check is a second layer. Errors are returned as `{"error": "<code>", "message": "..."}`.

## Clarifications (v1)

- `apiUrl` / `api_url` is the API base **without** `/v1`. Clients append `/v1/...`.
- Clients send the Cognito **ID token** as `Authorization: Bearer <jwt>`. The JWT authorizer's
  audience is the module's client id(s). The access token also works, because HTTP API
  authorizers match `aud` or `client_id`.
- `lastSeenTs` may be `null`, meaning the home has never been seen. `Entity.updated_ts` and the
  list response's `updatedTs` are optional.
- Light brightness uses `data.brightness` from 0 to 255.
- The Cognito app client is public: no secret, authorization-code flow with PKCE. The web
  `redirectUri` must be registered as both a callback URL and a logout URL.

## Reserved for v2

These names are reserved so no other change claims them. The mobile push and live-update
work is described in [mobile.md](mobile.md).

- MQTT `homecloud/{homeId}/event` (bridge → cloud): user-facing events that trigger push notifications.
- `POST /v1/devices` and `DELETE /v1/devices/{deviceId}`: register and unregister push tokens.
- `GET /v1/homes/{homeId}/summary`: entities plus home status in one call.
- `GET /v1/homes/{homeId}/history/{entityId}?from=&to=&res=raw|day`: returns `R#`/`D#` items
  (additive, so it can ship in `/v1` once the dashboard charts need it).
- WebSocket route `$connect?homeId=` for live state updates.
