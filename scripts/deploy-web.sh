#!/usr/bin/env bash
# Build the web UI and publish it to the bucket the module created.
#   ./scripts/deploy-web.sh [stack-dir]   (default: cloud/terraform/examples/standalone)
# Needs: node/npm, aws CLI, tofu (or set TOFU=terraform).
# config.json in the bucket is written by the module and is never touched here.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
stack="${1:-$root/cloud/terraform/examples/standalone}"
tofu_bin="${TOFU:-tofu}"

out() { "$tofu_bin" -chdir="$stack" output -raw "$1"; }
bucket="$(out web_bucket)"
dist_id="$(out web_distribution_id)"
web_url="$(out web_url)"

echo "Building web UI..."
(cd "$root/web" && npm ci --no-audit --no-fund && npm run build)

echo "Uploading to s3://$bucket ..."
# Hashed assets: cache for a year. index.html: never cache.
aws s3 sync "$root/web/dist/" "s3://$bucket/" --delete \
  --exclude "config.json" --exclude "config.example.json" --exclude "index.html" \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp "$root/web/dist/index.html" "s3://$bucket/index.html" \
  --cache-control "no-cache" --content-type "text/html"

echo "Invalidating CloudFront $dist_id ..."
aws cloudfront create-invalidation --distribution-id "$dist_id" --paths "/index.html" "/" >/dev/null

echo "Done: $web_url"
