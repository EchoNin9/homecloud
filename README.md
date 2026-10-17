# homecloud

**Home Assistant on your Synology, with your own cloud dashboard and API on AWS.**

- Home Assistant runs locally in Docker, so automations keep working if the internet goes down.
- A small **bridge** container connects *outbound* to AWS IoT Core. You open no ports and don't need port forwarding.
- The AWS side is a **Terraform module**: an HTTP API (Cognito JWT), DynamoDB, IoT Core and an optional React dashboard on S3/CloudFront.
- **Built to embed.** Drop the module into an existing stack and point it at an existing Cognito pool, mount the React component in your own app, or just call the API.

```
Home Assistant ⇄ bridge ──MQTT/TLS (outbound)──► AWS IoT Core ─► Lambda ─► DynamoDB ◄─ API (Cognito) ◄─ web / your app
```

The full message and API contract is in [docs/contract.md](docs/contract.md).

## Repo layout

| Path | What it is |
|---|---|
| `nas/` | Docker Compose stack: Home Assistant, Mosquitto, Zigbee2MQTT (optional), bridge |
| `cloud/terraform/modules/homecloud` | Reusable Terraform module |
| `cloud/terraform/examples/` | `standalone` and `existing-cognito` deployments |
| `cloud/lambdas/` | Ingest and API Lambdas (Python 3.12, boto3 only) |
| `web/` | React dashboard, embeddable `<HomeCloudDashboard>` component and dependency-free `HomeCloudClient` |
| `docs/` | Contract, Synology setup, integration recipes, [mobile app plan](docs/mobile.md) |

## Quick start

1. **Cloud:** run `cd cloud/terraform/examples/standalone && terraform init && terraform apply`.
   See [docs/integrate.md](docs/integrate.md) for how to get the device certificates out.
2. **NAS:** follow [docs/synology.md](docs/synology.md). In short: copy `nas/` to the NAS, fill
   in `.env`, drop the certificates in place, and create a Container Manager project from
   `docker-compose.yml`.
3. **Web:** run `cd web && npm ci && npm run build`, then upload `dist/` to the bucket the module
   created. Or try the UI without AWS using `npm run dev:mock`.

## Security model

- Each home gets its own X.509 certificate. Its IoT policy only allows that home's topics.
- Commands are checked against an allowlist twice: by the API and again by the bridge.
  `lock.unlock` is **off by default**.
- The bridge rejects stale (>60 s), future-dated and replayed commands.
- If you let Terraform generate the private key, it is stored in Terraform state. Pass a CSR
  (`device_csrs`) to keep the key off AWS entirely, or use encrypted remote state.

## Cost

About US$1–3/month for one home at typical usage (IoT messages, Lambda, on-demand DynamoDB,
CloudFront). See [docs/integrate.md](docs/integrate.md#cost) for the assumptions.

## Mobile apps

Android and iOS apps are planned as a single Expo (React Native) app that reuses
`HomeCloudClient`. They are deferred until the web UI is live and connected to the on-prem
stack (milestone M1). See
[docs/mobile.md](docs/mobile.md).

## Contributing

`main` is production and only accepts merges from `develop`. Open PRs against `develop`.
Agents should read [CLAUDE.md](CLAUDE.md), which is also available as `AGENTS.md`.

## License

MIT
