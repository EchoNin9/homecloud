# First deploy checklist (to milestone M1)

Goal: the web UI on CloudFront signs in, shows your real Home Assistant entities, and toggles a
real device. Every phase ends with a **smoke test**. Don't move on until it passes; the table at
the end maps each failure to its usual cause.

Time: about 1–2 hours. Commands assume the repo root unless a `cd` says otherwise.

## 0. Prerequisites

- [ ] AWS account and an admin CLI profile: `export AWS_PROFILE=... AWS_REGION=us-east-1`.
      Any IoT Core region works; use the same region everywhere below.
- [ ] **OpenTofu ≥ 1.10** (`tofu version`). Terraform ≥ 1.10 also works if you set `TOFU=terraform`
      for the scripts.
- [ ] Node 20+ and npm, and `jq`.
- [ ] Synology DSM 7.2+ with Container Manager installed and SSH enabled.
- [ ] Home Assistant isn't running yet, or you'll move an existing install into
      `/volume1/docker/homecloud/homeassistant`.

## 1. State bucket (one time per AWS account)

OpenTofu state for every homecloud stack lives in one S3 bucket. The bucket is versioned,
encrypted, blocks public access, allows TLS only, and expires old state versions after 90 days.
Locking uses S3 lockfiles, so no DynamoDB table is needed.

```sh
cd cloud/terraform/bootstrap
tofu init && tofu apply                   # creates homecloud-tfstate-<account>-<region>
tofu output -raw backend_hcl              # you'll paste this in step 3
```

Then move the bootstrap stack's own state into the bucket, so nothing is kept only on your
laptop:

```sh
printf 'terraform {\n  backend "s3" {}\n}\n' > backend_override.tf   # gitignored
tofu init -migrate-state \
  -backend-config="bucket=$(tofu output -raw bucket)" \
  -backend-config="key=homecloud/bootstrap.tfstate" \
  -backend-config="region=$AWS_REGION" \
  -backend-config="encrypt=true" -backend-config="use_lockfile=true"
rm -f terraform.tfstate terraform.tfstate.backup
```

**Smoke test:** `aws s3 ls s3://<bucket>/homecloud/` lists `bootstrap.tfstate`, and
`aws s3api get-bucket-versioning --bucket <bucket>` shows `"Status": "Enabled"`.

## 2. Device key and CSR (on the NAS, so the private key never leaves it)

```sh
ssh you@nas
sudo mkdir -p /volume1/docker/homecloud/bridge/certs && cd /volume1/docker/homecloud/bridge/certs
sudo openssl req -new -newkey rsa:2048 -nodes \
  -keyout private.key -out home.csr -subj "/CN=homecloud-home"
sudo chmod 600 private.key
```

Copy **only** `home.csr` to your deploy machine, at
`cloud/terraform/examples/standalone/certs/home.csr` (gitignored).

**Smoke test:** `openssl req -in home.csr -noout -verify` prints `verify OK`.

## 3. Cloud stack

```sh
cd cloud/terraform/examples/standalone
cp backend.hcl.example backend.hcl            # paste the backend_hcl output from step 1
cp terraform.tfvars.example terraform.tfvars  # region, home_ids, device_csr_files
tofu init -backend-config=backend.hcl
tofu plan -out=plan.bin                       # look it over: ~40 resources, nothing destroyed
tofu apply plan.bin
```

**Smoke tests**
- [ ] `curl -s "$(tofu output -raw api_url)/v1/health"` returns `{"ok": true, ...}`.
- [ ] `aws s3 ls s3://<state-bucket>/homecloud/` now also lists `standalone.tfstate`.
- [ ] `tofu output private_keys` is empty, because you used a CSR.

Note these values for the NAS: `tofu output -raw iot_endpoint` and `tofu output -json thing_names`
(for example `{"home":"homecloud-home"}`).

## 4. Certificate to the NAS

```sh
tofu output -json certificate_pems | jq -r '.home' > cert.pem
curl -sO https://www.amazontrust.com/repository/AmazonRootCA1.pem
scp cert.pem AmazonRootCA1.pem you@nas:/tmp/
```

Then on the NAS:

```sh
cd /volume1/docker/homecloud/bridge/certs
sudo mv /tmp/cert.pem /tmp/AmazonRootCA1.pem . && sudo rm -f home.csr
sudo chown -R 10001:10001 . && sudo chmod 700 . && sudo chmod 600 private.key
ls   # AmazonRootCA1.pem  cert.pem  private.key
```

**Smoke test (on the NAS):** the cert matches the key. These two hashes must be identical:

```sh
sudo openssl x509 -noout -pubkey -in cert.pem | openssl sha256
sudo openssl pkey -pubout -in private.key | openssl sha256
```

## 5. Your login

```sh
POOL=$(tofu output -raw user_pool_id)
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username you@example.com --group-name admin
```

Cognito emails you a temporary password. You'll set a new one at first sign-in in step 7.

**Smoke test:** `aws cognito-idp admin-list-groups-for-user --user-pool-id "$POOL" --username you@example.com`
lists `admin`.

## 6. NAS stack

Follow [synology.md](synology.md) steps 1, 3, 4 and 5 (skip step 2: certificates are already done).
Set these values in `.env`:

| `.env` key | Value |
|---|---|
| `HOME_ID` | `home` (must match `home_ids`) |
| `IOT_ENDPOINT` | `tofu output -raw iot_endpoint` |
| `IOT_THING_NAME` | `homecloud-home`, from `thing_names` |
| `HA_TOKEN` | the long-lived token from HA (synology.md step 5) |

**Smoke tests**
- [ ] `sudo docker logs homecloud-bridge-1` shows `connected to Home Assistant`, `connected to IoT Core`
      and `snapshot sent: N entities` with N > 0.
- [ ] From the deploy machine, the cloud sees the home as online:
  ```sh
  aws dynamodb get-item --table-name "$(tofu output -raw table_name)" \
    --key '{"PK":{"S":"HOME#home"},"SK":{"S":"META"}}' --query 'Item.online'
  ```
  This returns `{"BOOL": true}`.

## 7. Web UI

```sh
./scripts/deploy-web.sh        # builds web/, syncs to the bucket, invalidates CloudFront
```

This leaves the module-managed `config.json` in the bucket untouched.

**Smoke tests**
- [ ] `curl -s "$(cd cloud/terraform/examples/standalone && tofu output -raw web_url)/config.json"`
      shows your `apiUrl`, `userPoolId` and `clientId`.
- [ ] Open `web_url`, sign in (set your new password), and your home shows as **online** with
      entities grouped by domain.

## 8. End to end (this is M1)

- [ ] Toggle a light or switch in the web UI. The physical device changes within about 2 s and
      the toggle stays put rather than reverting.
- [ ] Bridge log shows `command c_... light.turn_on -> ok`.
- [ ] Change the device from the HA UI or a wall switch. The web UI reflects it within about 5 s,
      one poll cycle.

When all three pass, tick M1 in [mobile.md](mobile.md). Mobile work can then start.

## Troubleshooting

| Symptom | Usual cause | Fix |
|---|---|---|
| `tofu init`: `Unsupported argument "use_lockfile"` | OpenTofu or Terraform older than 1.10 | Upgrade, or replace `use_lockfile` with a DynamoDB `dynamodb_table` |
| `tofu apply`: Cognito domain already exists | The hosted UI prefix is globally unique per region | Set `cognito_domain_prefix` in the module call |
| Bridge: TLS or connection refused to IoT | Client id isn't the thing name, wrong endpoint, or wrong file permissions | Check `IOT_THING_NAME` and `IOT_ENDPOINT`; certificates must be readable by UID 10001 |
| Bridge: connects, then drops every few seconds | Two bridges using the same client id | Run only one bridge per home |
| Bridge: `auth_invalid` from HA | Token pasted with whitespace, or revoked | Create a new long-lived token |
| `snapshot sent: 0 entities` | Domain filter excludes everything | Check `BRIDGE_ALLOWED_DOMAINS` and `BRIDGE_ENTITY_EXCLUDE` |
| META `online` missing | The IoT rule isn't firing | CloudWatch log group of the topic rule error action, and the ingest Lambda logs |
| Login: `redirect_mismatch` | The web URL isn't in the client's callback URLs | Re-apply; custom domains go in `web_callback_urls` |
| UI shows 403 | User isn't in the `admin` group, or a stale token from before the group was added | Add to the group, then sign out and back in |
| UI shows CORS error | API called from an origin the module doesn't know | Add the origin to `web_callback_urls` |
| Toggle reverts, toast says `stale` | NAS clock is off by more than 60 s | DSM → Regional Options → NTP |
| Toggle reverts, toast says `not_allowed` | Service isn't in `allowed_services` (API) or `BRIDGE_ALLOWED_SERVICES` (bridge) | Add it to both |

## Teardown

`tofu destroy` in `examples/standalone` removes everything except the state bucket, which has
`prevent_destroy`. Delete the bucket by hand only once no stack uses it.
