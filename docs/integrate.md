# Integrating the HomeCloud cloud half

The OpenTofu module (Terraform-compatible) in `cloud/terraform/modules/homecloud` implements the AWS side of
[`contract.md`](contract.md): DynamoDB, IoT Core (thing + cert + policy per home), two Lambdas,
an HTTP API with a Cognito JWT authorizer and, optionally, private web hosting.

Three ways to use it, from most to least integrated.

## 1. Standalone deploy

Creates everything: a Cognito pool, a public client (code + PKCE) and a hosted UI domain, plus
the API, IoT resources, and S3 + CloudFront for the SPA. State goes in S3 (see below).

**Follow [first-deploy.md](first-deploy.md).** It covers the state bucket, CSR, apply,
certificates, your login, the NAS and the web upload, with a smoke test after each step.

The SPA is published with `./scripts/deploy-web.sh`. The bucket's `config.json` (`apiUrl`,
`region`, `userPoolId`, `clientId`, `cognitoDomain`) is managed by the module and left alone.
`apiUrl` has no `/v1` suffix.

### State: S3 backend (OpenTofu)

Both examples declare `backend "s3" {}` and read their settings from `backend.hcl`. Copy
`backend.hcl.example`, then run `tofu init -backend-config=backend.hcl`. The bucket comes from
`cloud/terraform/bootstrap`, which creates a versioned, encrypted, public-blocked, TLS-only bucket.
Locking uses S3 lockfiles (`use_lockfile = true`, OpenTofu or Terraform ≥ 1.10), so no DynamoDB
table is needed. When you use the module inside your own stack, keep using your stack's existing
backend.

### Device certificates for the NAS

**Preferred: bring your own CSR (private key never enters state).**

```bash
openssl req -new -newkey rsa:2048 -nodes -keyout home.key -out home.csr -subj "/CN=homecloud-home"
tofu apply -var 'device_csrs={home="'"$(cat home.csr)"'"}'   # or put it in a .tfvars file
tofu output -json certificate_pems | jq -r .home > home.pem
```

**Fallback: let AWS generate the key.** Simpler, but the private key is stored in
**plaintext in state**. Use an encrypted remote backend with tight access, or do not use this.

```bash
tofu output -json certificate_pems | jq -r .home > home.pem
tofu output -json private_keys     | jq -r .home > home.key && chmod 600 home.key
```

Then the root CA and the endpoint for the bridge:

```bash
curl -o AmazonRootCA1.pem https://www.amazontrust.com/repository/AmazonRootCA1.pem
tofu output -raw iot_endpoint      # MQTT over TLS, port 8883
tofu output -json thing_names      # MQTT client id MUST equal this (e.g. homecloud-home)
```

## 2. As a module in an existing stack with an existing Cognito pool

If your stack already owns a pool (for example echo9's funkedupshift, which exposes
`cognitoUserPoolId` / `cognitoClientId` outputs and uses groups `admin` / `manager` / `user`):

```hcl
module "homecloud" {
  source = "github.com/EchoNin9/homecloud//cloud/terraform/modules/homecloud?ref=v0.1.0"

  home_ids = ["home"]

  # same stack:                         # or another stack, via terraform_remote_state
  existing_user_pool_id         = aws_cognito_user_pool.main.id
  existing_user_pool_client_ids = [aws_cognito_user_pool_client.web.id]

  allowed_groups     = ["admin"]            # cognito:groups must intersect this
  create_web_hosting = false                # you already have a SPA
  web_callback_urls  = ["https://app.example.com"]  # only used for API CORS here
}

output "homecloud_api_url" { value = module.homecloud.api_url }
```

Notes:

- The module does **not** touch your client: your SPA's client keeps its own callback/logout URLs.
- The JWT authorizer accepts ID tokens (`aud`) and access tokens (`client_id`) from any client
  in `existing_user_pool_client_ids`. Send the **ID token**; `cognito:groups` is in both.
- The module needs the lambda sources, so the `//cloud/terraform/...` git form is required
  (the whole repo is cloned); the Terraform registry's "module only" packaging would not include them.
- A runnable version reading the outputs via `terraform_remote_state` is in
  `cloud/terraform/examples/existing-cognito`.

## 3. Call the HTTP API from any app

All routes except `/v1/health` need `Authorization: Bearer <Cognito ID token>` and a
`cognito:groups` claim intersecting `allowed_groups`. `API` is `api_url` (no `/v1`).

```bash
API=$(tofu output -raw api_url)
curl "$API/v1/health"

# Get a token for testing. This needs enable_password_auth = true on the module, which is off by default.
TOKEN=$(aws cognito-idp initiate-auth --client-id "$(tofu output -raw user_pool_client_id)" \
  --auth-flow USER_PASSWORD_AUTH --auth-parameters USERNAME=you@example.com,PASSWORD='...' \
  --query AuthenticationResult.IdToken --output text)

curl -H "Authorization: Bearer $TOKEN" "$API/v1/homes"
curl -H "Authorization: Bearer $TOKEN" "$API/v1/homes/home/entities?domain=light"
curl -H "Authorization: Bearer $TOKEN" "$API/v1/homes/home/entities/light.kitchen"

curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"domain":"light","service":"turn_on","target":{"entity_id":"light.kitchen"},"data":{"brightness":200}}' \
  "$API/v1/homes/home/commands"          # 202 {"id":"c_...","status":"pending"}
curl -H "Authorization: Bearer $TOKEN" "$API/v1/homes/home/commands/c_..."
```

Status codes: 400 `bad_request` / `not_allowed`, 403 `forbidden`, 404 `not_found`, 502 `publish_failed`.
A command is `pending` until the bridge acks (`ok` or `error`); it expires from DynamoDB after 7 days.

## Behaviour worth knowing

- **Snapshots do not delete.** A `snapshot: true` batch only upserts. Entities disappear only
  through `removed` in a StateBatch.
- **Ordering.** ENTITY writes are conditional on `last_changed` (incoming >= stored); stale items
  are skipped individually.
- **Topic rules.** One rule per topic (`state`, `status`, `cmd/ack`) instead of one
  `FROM 'homecloud/+/#' WHERE ...` rule: the ack filter needs `topic(4)`, which is undefined on
  3-segment topics, and undefined-in-OR semantics are easy to get wrong. Narrow rules also never
  fire for the cloud's own `cmd` publishes. The SELECT also adds `topic(4) AS sub` and
  `clientid() AS clientId`; ingest drops messages whose client id is not `{prefix}-{homeId}`.
- **Defaults for `allowed_services`:** light, switch, fan turn_on/turn_off; scene.turn_on;
  climate.set_temperature; cover.open_cover/close_cover. No `lock.*`.
- After uploading a new SPA build, invalidate CloudFront (`web_distribution_id` output).

## Cost estimate, one home

Assumptions: us-east-1, one bridge connected 24/7, ~60 state messages/min on average (5 KB each,
hence 1 metering unit of 5 KB), ~20 commands/day, 1 user, ~500 API calls/day, 1 GB of web
traffic/month, no free tier counted.

| Item | Basis | USD/month |
|---|---|---|
| IoT Core messages | 60/min * 43,200 min = 2.6M msgs at $1.00/M | 2.60 |
| IoT connectivity | 1 device, 43,200 min at $0.08/M min | 0.00 |
| IoT rules | 2.6M rule triggers + actions at ~$0.15/M each | 0.80 |
| DynamoDB on-demand writes | ~2.6M WRU at $0.625/M (conditional put, 1 KB) | 1.60 |
| DynamoDB storage + PITR | < 1 MB | 0.01 |
| Lambda (ingest + api) | ~2.7M invocations, short | 0.60 |
| API Gateway HTTP | ~15k requests at $1.00/M | 0.02 |
| CloudFront + S3 | 1 GB out, tiny storage | 0.10 |
| Cognito | < 10k MAU free tier (Essentials) | 0.00 |
| CloudWatch Logs | 30-day retention, low volume | 0.10 |
| **Total** | busy home | **~5-6** |

That is a pessimistic average: 60 msgs/min is a chatty home. HA state changes in a typical home are
closer to 5-10/min after the bridge's filter (use the bridge domain/entity filter and skip noisy
sensors), which gives roughly **1-3 USD/month** (IoT messages and DynamoDB writes scale linearly with
message rate and dominate). The 15-minute snapshots add ~100 messages/day per snapshot batch.

## Mobile apps

To let the planned Android/iOS app sign in, set `native_redirect_uris = ["homecloud://auth"]`
on the module. That adds the URI to the created Cognito client's callback and logout URLs.
If you bring your own pool, add the same URI to your app client yourself. Native apps call the
same `/v1` API with the same ID token. See [mobile.md](mobile.md).
