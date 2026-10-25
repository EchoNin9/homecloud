#!/bin/sh
# Set sensor.docker_<name> in Home Assistant for every container, every INTERVAL seconds.
# Shape: docs/contract.md "NAS container sensors". Runs in the `monitor` service (docker:cli, busybox).
# Only compose containers (any project): one-off `docker run` containers would raise false "Service down" chips.
# ponytail: states set through HA's REST API vanish on HA restart until the next push, and a removed
# container keeps its last state (restart HA to clear it, docs/synology.md §9). Use a custom HA integration if that ever matters.
set -u
FMT='{{slice .Name 1}} {"state":{{json .State.Status}},"attributes":{"friendly_name":{{json (slice .Name 1)}},"image":{{json .Config.Image}},"started_at":{{json .State.StartedAt}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"icon":"mdi:docker"}}'
while :; do
  # shellcheck disable=SC2046
  docker inspect --format "$FMT" $(docker ps -aq --filter label=com.docker.compose.project) | while read -r name body; do
    id=$(echo "$name" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '_')
    wget -q -O /dev/null --header "Authorization: Bearer $HA_TOKEN" --header "Content-Type: application/json" \
      --post-data "$body" "$HA_URL/api/states/sensor.docker_$id" || echo "push failed: $name" >&2
  done
  sleep "${INTERVAL:-60}"
done
