# Mobile apps (Android / iOS) — design notes

Status: **deferred.** Nothing here is built yet.

**Gate: don't start mobile work until milestone M1 is done.** M1 means:
1. The cloud module is deployed to a real AWS account.
2. The bridge on the Synology is connected (`GET /v1/homes` shows `online: true`).
3. The web UI on CloudFront signs in with Cognito, shows live Home Assistant entities, and
   successfully toggles at least one real device end to end.

Until then, these notes only exist so that v0.1 doesn't paint us into a corner.

## Decision: one Expo (React Native) app for both platforms

- **One TypeScript codebase** builds Android and iOS. EAS Build handles signing and store
  submission.
- **Reuses `web/src/client`** (`HomeCloudClient` and its types) unchanged. It has no DOM or
  browser APIs, only `fetch`, by design. Keep it that way: CI should fail if
  `web/src/client` imports anything outside its own folder.
- **Doesn't reuse `web/src/auth`.** That module is browser-only (sessionStorage and
  redirects). The app uses `expo-auth-session` with the same Cognito public client and PKCE
  flow, and keeps the refresh token in `expo-secure-store` (Keychain / Android Keystore).
- Native Kotlin/Swift apps were considered and rejected. They would mean two codebases for a
  dashboard-style app, and home-screen widgets are the only place native wins. Expo
  supports widgets through config plugins later.

When the app starts, move `web/src/client` to `packages/client` (an npm workspace) so the
web and mobile apps both import it. Don't do this before then.

## What v0.1 already provides for mobile

| Need | v0.1 support |
|---|---|
| Sign-in | Cognito hosted UI with PKCE on a public client. Set the module input `native_redirect_uris = ["homecloud://auth"]`. |
| Read state / send commands | `/v1` HTTP API with an ID-token bearer, identical to the web app. |
| Command feedback | `POST /commands` returns a command id, then `waitForCommand` polls for it. |
| Offline home | `GET /v1/homes` gives `online` and `lastSeenTs`. Show these, and disable controls while offline. |
| Safety | Two allowlists, with `lock.unlock` off by default. The app should add a biometric confirm before any lock, cover or alarm command. |

## Gaps to close for mobile (v0.2 backlog, in priority order)

1. **Push notifications.** This is the main reason to have an app at all.
   - **Bridge:** forwards selected HA events, for example a `homecloud_notify` event fired
     by HA automations, to `homecloud/{homeId}/event`.
   - **Cloud:** ingest sends them to SNS mobile push (FCM for Android, APNs for iOS) or to
     the Expo push service. Pick Expo push for v0.2 because it needs no SNS platform
     applications.
   - **API:** add `POST /v1/devices` and `DELETE /v1/devices/{id}` to register and
     unregister push tokens.
2. **Live updates instead of polling.** Mobile polling every 5 s drains the battery. Options:
   - an API Gateway WebSocket API fed by ingest (recommended: same Cognito auth)
   - IoT Core over WSS with a Cognito identity pool (cheaper, but needs more IAM)
3. **Fewer round trips.** A `GET /v1/homes/{homeId}/summary` endpoint would return entities
   plus home status in one call.
4. **Per-user home access.** This matters if you share the app with family or other
   households. Today any user in an allowed group sees every home.
5. **Widgets and quick tiles.** An Android Quick Settings tile and iOS widgets for favourite
   scenes. Needs a small native module.

Topic and route names for 1 and 2 are reserved in [contract.md](contract.md#reserved-for-v2) so
nothing else claims them.

## Relationship to the official Home Assistant Companion app

The HA Companion app needs HA to be reachable remotely, through Nabu Casa or by exposing
HA yourself. The HomeCloud app goes through AWS only. The NAS opens no ports, logins use your
Cognito, and commands are limited to an allowlist. Both apps can be installed side by side.
