# Running the NAS stack on Synology (DSM 7.2)

Stack: Home Assistant, Mosquitto, optional Zigbee2MQTT, and the `bridge` that links HA to AWS IoT Core.
Everything is outbound-only; open no ports on your router.

Requirements: DSM 7.2+, **Container Manager** (Package Center), an x86_64 or arm64 NAS, SSH enabled
(Control Panel -> Terminal & SNMP) for the one-off steps below.

## 1. Folders

```sh
sudo mkdir -p /volume1/docker/homecloud/{homeassistant,mosquitto/data,zigbee2mqtt,bridge/certs,backups}
```

Copy the contents of the repo's `nas/` directory (compose file, `bridge/`, `mosquitto/`, `scripts/`,
`.env.example`) to `/volume1/docker/homecloud/stack/`, e.g. with File Station or `scp`.
`DATA_ROOT` (runtime data) and the stack directory (code) are separate on purpose, so backups of
`DATA_ROOT` stay small.

## 2. Cloud credentials

The Terraform cloud module outputs, per home: `cert.pem`, `private.key` and the IoT endpoint, plus
`AmazonRootCA1.pem` (from <https://www.amazontrust.com/repository/AmazonRootCA1.pem>). Place them in
`/volume1/docker/homecloud/bridge/certs/`:

```sh
cd /volume1/docker/homecloud/bridge/certs
ls            # cert.pem  private.key  AmazonRootCA1.pem
sudo chown -R 10001:10001 . && sudo chmod 700 . && sudo chmod 600 private.key
```

UID 10001 is the bridge container's non-root user. The compose file mounts this folder read-only.

## 3. Mosquitto password file

Mosquitto refuses anonymous clients; create the password file before first start:

```sh
cd /volume1/docker/homecloud/mosquitto
sudo docker run --rm -v "$PWD":/work eclipse-mosquitto:2 \
  mosquitto_passwd -c -b /work/passwd homecloud 'CHOOSE-A-PASSWORD'
sudo chown 1883:1883 passwd && sudo chmod 600 passwd
```

Add more users later with the same command without `-c`. The broker is published on `127.0.0.1:1883`
only, so it is reachable from HA (host network) and Zigbee2MQTT but not from the LAN.

## 4. Configure and start

1. Copy `.env.example` to `.env` next to `docker-compose.yml` and fill it in (`HOME_ID`, `IOT_ENDPOINT`,
   `IOT_THING_NAME`, `DATA_ROOT`, `TZ`). Leave `HA_TOKEN` for step 5.
2. Container Manager -> **Project** -> **Create**. Name `homecloud`, path
   `/volume1/docker/homecloud/stack`, source **Use existing docker-compose.yml**. Container Manager
   picks up the `.env` in the same folder. Don't start the project yet (or accept that `bridge` will
   fail until step 5).
3. Start HA and Mosquitto first: from SSH, `sudo docker compose up -d homeassistant mosquitto`
   (from the stack folder), or just build and start the project and finish step 5 afterwards.

Home Assistant is then at `http://<nas-ip>:8123`. Complete onboarding, then add the **MQTT**
integration: broker `127.0.0.1`, port 1883, user `homecloud` and the password from step 3.

## 5. Home Assistant token

In HA: your profile (bottom-left) -> **Security** -> **Long-lived access tokens** -> Create. Paste it
into `.env` as `HA_TOKEN`, then in Container Manager open the project -> **Action -> Build / Stop /
Start** (or `sudo docker compose up -d --build bridge`). The token is shown only once. Use a dedicated
HA user if you want to limit what the bridge can reach; the bridge's own allowlists are the main
control.

**If the build fails with `seccomp: config provided but seccomp not supported`** (DSM's kernel lacks
seccomp, which BuildKit expects; seen on DSM 7.4 / DS1819+), build with the legacy builder, then start
without building:

```sh
sudo DOCKER_BUILDKIT=0 docker build -t homecloud-bridge:0.1.0 bridge
sudo docker compose up -d --no-build bridge
```

The Container Manager **Build** action hits the same error; once the image exists, plain Start/Restart works.

Check `docker logs homecloud-bridge-1`: expect `connected to Home Assistant`, `connected to IoT Core`,
`snapshot sent: N entities`.

### What the bridge exposes

`BRIDGE_ALLOWED_DOMAINS` and `BRIDGE_ENTITY_EXCLUDE` (globs) decide which entities are sent to the cloud.
`BRIDGE_ALLOWED_SERVICES` is the only set of HA services the cloud can invoke. `lock.unlock` is
deliberately absent by default: anyone who obtains a cloud credential could otherwise open your door.
Adding it is your call; consider excluding specific locks by glob.

## 6. Zigbee (optional)

1. Plug in the coordinator and find it: `ls /dev/ttyUSB* /dev/ttyACM*`.
2. **Driver caveat.** Many Synology models ship without the USB-serial drivers for common sticks. Sticks
   using CP210x (e.g. Sonoff ZBDongle-P, SkyConnect) or CH340/CH341 (e.g. ZBDongle-E variants) may not appear
   as `/dev/ttyUSB0`. Community-built driver packages exist (search for "Synology USB serial drivers
   cp210x ch341 DSM 7"; they are matched to your NAS CPU architecture and DSM version) and are installed
   by hand, often needing a re-load after DSM updates. Sticks that present as CDC-ACM (`/dev/ttyACM0`)
   usually work with the built-in `cdc-acm` module. Support differs per model and DSM version; verify
   before buying hardware. Using a network-attached coordinator (SLZB-06 style, `tcp://` serial) avoids
   all of this.
3. Set `ZIGBEE_DEVICE=/dev/ttyUSB0` (or your path) in `.env`. The compose file maps it to
   `/dev/ttyZigbee` in the container.
4. Create `/volume1/docker/homecloud/zigbee2mqtt/configuration.yaml`:
   ```yaml
   homeassistant: true
   mqtt:
     server: mqtt://mosquitto:1883
     user: homecloud
     password: CHOOSE-A-PASSWORD
   serial:
     port: /dev/ttyZigbee
   frontend: true
   ```
5. Start with `sudo docker compose --profile zigbee up -d` (in Container Manager: add `--profile` via
   SSH; the UI project start does not enable profiles). Zigbee2MQTT UI: port 8080 on the container's
   network only. Publish it yourself if you need it.

## 7. Backups

- `scripts/backup.sh` tars `DATA_ROOT` (excluding caches/logs) into `DATA_ROOT/backups`, keeps the newest 7,
  and uploads to S3 if `BACKUP_S3_URI` is set (needs the AWS CLI configured on the NAS). Schedule it in
  DSM: Control Panel -> **Task Scheduler** -> Create -> Scheduled Task -> User-defined script,
  e.g. `DATA_ROOT=/volume1/docker/homecloud BACKUP_S3_URI=s3://bucket/homecloud/ /volume1/docker/homecloud/stack/scripts/backup.sh`.
- The archive contains your IoT private key and HA secrets: keep the bucket private and encrypted.
- **Hyper Backup** can instead protect the whole `/volume1/docker` shared folder (to another NAS, USB or
  cloud). For a consistent HA copy, prefer also using HA's built-in backups (Settings -> System -> Backups)
  which land in `homeassistant/backups`.

## Troubleshooting

| Symptom | Check |
|---|---|
| `bridge` exits immediately with `invalid configuration` | The message lists every bad/missing variable and missing cert file. |
| `Home Assistant rejected the access token` | Token revoked or mistyped; recreate it. Recreate the container after editing `.env`. |
| Bridge can't reach `127.0.0.1:8123` | HA must run with `network_mode: host`; check HA is up and `HA_URL` has the right port. |
| IoT connect loops with TLS / `not authorized` | Thing name must equal the MQTT client id; cert must be attached to the Thing and an active policy; use the account's `-ats` endpoint with `AmazonRootCA1.pem`. Clock drift also breaks TLS: enable NTP in DSM. |
| `PermissionError` reading `private.key` | `chown 10001` on the certs folder and key (step 2). |
| Commands come back `not_allowed` | The service is not in `BRIDGE_ALLOWED_SERVICES`, or the entity is excluded / outside the allowed domains. |
| Commands come back `stale` | NAS clock skew over 60 s (or 10 s ahead of the cloud). Fix NTP. |
| Mosquitto exits | Missing or wrongly-owned `passwd` file (step 3), see `docker logs`. |
| Zigbee device not found | `ls /dev/tty*` on the NAS; driver not loaded (step 6); container needs the device path in `.env`. |
| Ports 8123 / 1883 busy | Another package uses them; Home Assistant on host networking cannot change port without editing HA's `http:` config. |
