# CLAUDE.md / AGENTS.md — homecloud

These instructions are for every coding agent working in this repo (Claude Code, Antigravity,
Codex and others). `AGENTS.md` is a symlink to this file.

## Branch rules (enforced by repo rulesets)

- `main` is the default and production branch. **Only `develop` may be merged into `main`**,
  through a PR. The `branch-policy` check fails any other source.
- **Agents never push to `main`.** Work on a feature branch, open a PR into **`develop`**,
  and merge once CI is green. Promote by opening a PR from `develop` into `main`, and only
  when a human asks.
- Never force-push `main` or `develop`.

## Contract first

`docs/contract.md` is the single source of truth for MQTT topics, payloads, DynamoDB items
and the HTTP API. Change it **first**, in the same PR as the code. The three parts (`nas/`,
`cloud/`, `web/`) are built to the contract independently.

## Mobile apps are planned. Keep these working

- `web/src/client` stays free of the DOM and of dependencies, because the Expo app will
  reuse it. CI enforces this.
- API changes are **additive** within `/v1`. Mobile builds in the stores can't be
  force-updated, so a breaking change needs `/v2`.
- See `docs/mobile.md` for the design and the v0.2 backlog. Names reserved for v2 are at
  the end of the contract.

## Tests (CI runs all of these)

| Part | Command |
|---|---|
| Bridge | `cd nas/bridge && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt && .venv/bin/python -m pytest -q` |
| Cloud | `cd cloud && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/python -m pytest -q` |
| Terraform | `terraform fmt -check -recursive cloud/terraform`, then `terraform init -backend=false && terraform validate` in each `cloud/terraform/examples/*` |
| Web | `cd web && npm ci && npm run typecheck && npm run build && npm test -- --run` |

## Gotchas

- DynamoDB tests use **moto**, not MagicMock, so boto3's real serializer runs. Floats go
  through `hc_common.to_dynamo`, which converts them to `Decimal`. `online` is a reserved
  word, so alias it in expressions.
- A new Python dependency for a Lambda breaks the "boto3 only, zip with archive_file"
  packaging. Avoid it, or add a layer on purpose.
- The bridge runs with a read-only filesystem, as UID 10001. Certificates must be readable
  by that UID.
- Default command allowlists exclude `lock.unlock`. Don't add it to the defaults.
