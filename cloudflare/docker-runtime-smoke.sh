#!/usr/bin/env sh
set -eu

if [ "$(id -u)" = "0" ]; then
  export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"
else
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/home/rootless/.docker-run}"
  export DOCKER_HOST="${DOCKER_HOST:-unix://$XDG_RUNTIME_DIR/docker.sock}"
fi

DOCKER_BIN="${PAPERCLIP_REAL_DOCKER:-/usr/local/bin/docker-real}"
alpine_tag="paperclip-smoke-alpine-$$"
debian_tag="paperclip-smoke-debian-$$"

cleanup() {
  "$DOCKER_BIN" image rm "$alpine_tag" "$debian_tag" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

"$DOCKER_BIN" info >/dev/null
"$DOCKER_BIN" run --rm --network=host alpine:3.20 nslookup deb.debian.org >/dev/null
"$DOCKER_BIN" build --network=host -t "$alpine_tag" - <<'EOF'
FROM alpine:3.20
RUN apk add --no-cache curl
EOF
"$DOCKER_BIN" build --network=host -t "$debian_tag" - <<'EOF'
FROM debian:bookworm
RUN apt-get update
EOF

echo "docker host-network egress smoke ok"
