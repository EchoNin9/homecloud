#!/bin/sh
# One-time NAS setup: run as root (sudo). Idempotent.
set -eu
R=/volume1/docker/homecloud
export PATH=/usr/local/bin:$PATH

chown -R 10001:10001 $R/bridge/certs && chmod 700 $R/bridge/certs && chmod 600 $R/bridge/certs/private.key

if [ ! -f $R/mosquitto/passwd ]; then
  PW=$(openssl rand -base64 18 | tr -d '/+=')
  docker run --rm -v $R/mosquitto:/work eclipse-mosquitto:2 mosquitto_passwd -c -b /work/passwd homecloud "$PW"
  chown 1883:1883 $R/mosquitto/passwd && chmod 600 $R/mosquitto/passwd
  echo "MQTT user: homecloud  password: $PW   <-- save this, needed for the HA MQTT integration"
fi
chown -R 1883:1883 $R/mosquitto/data

cd $R/stack && docker compose up -d homeassistant mosquitto && docker compose ps
