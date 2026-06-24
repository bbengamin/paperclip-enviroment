#!/usr/bin/env sh
set -eu

if [ "$(id -u)" = "0" ]; then
  export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"
else
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/home/rootless/.docker-run}"
  export DOCKER_HOST="${DOCKER_HOST:-unix://$XDG_RUNTIME_DIR/docker.sock}"
fi

DOCKER_BIN="${PAPERCLIP_REAL_DOCKER:-/usr/local/bin/docker-real}"
network_name="paperclip-bridge-smoke-$$"

"$DOCKER_BIN" info >/dev/null
"$DOCKER_BIN" network create "$network_name" >/dev/null
trap '"$DOCKER_BIN" network rm "$network_name" >/dev/null 2>&1 || true' EXIT INT TERM
"$DOCKER_BIN" network inspect "$network_name" >/dev/null

echo "docker bridge network smoke ok"

