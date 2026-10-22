#!/usr/bin/env bash
# One-time repo setup (run as a repo admin, with the GitHub CLI logged in):
#   ./scripts/setup-branch-rules.sh EchoNin9/homecloud
# Creates two rulesets:
#   main    - changes only via PR, CI plus branch-policy must pass (so only develop can merge in),
#             no force-push or deletion
#   develop - changes only via PR (agents merge here), CI must pass, no force-push or deletion
# Re-running updates the existing rulesets in place.
set -euo pipefail
repo="${1:?usage: $0 owner/repo}"

ci_checks='{"context":"bridge"},{"context":"cloud"},{"context":"web"},{"context":"compose"}'

ruleset() { # name branch extra_checks
  cat <<JSON
{
  "name": "$1",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/$2"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [ ${ci_checks}$3 ] } }
  ]
}
JSON
}

apply() { # name branch extra_checks
  id=$(gh api "repos/$repo/rulesets" --jq ".[] | select(.name==\"$1\") | .id" || true)
  if [ -n "$id" ]; then
    ruleset "$@" | gh api -X PUT "repos/$repo/rulesets/$id" --input - >/dev/null && echo "updated $1"
  else
    ruleset "$@" | gh api -X POST "repos/$repo/rulesets" --input - >/dev/null && echo "created $1"
  fi
}

gh api -X PATCH "repos/$repo" -f default_branch=main >/dev/null && echo "default branch: main"
apply "main: only develop via PR" main ',{"context":"only-develop-into-main"}'
apply "develop: PR + CI" develop ''
