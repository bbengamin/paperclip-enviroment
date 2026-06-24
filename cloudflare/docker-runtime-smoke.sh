#!/usr/bin/env sh
set -eu

if [ "$(id -u)" = "0" ]; then
  export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"
else
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/home/rootless/.docker-run}"
  export DOCKER_HOST="${DOCKER_HOST:-unix://$XDG_RUNTIME_DIR/docker.sock}"
fi

DOCKER_BIN="${PAPERCLIP_REAL_DOCKER:-/usr/local/bin/docker-real}"
DOCKER_WRAPPER="${PAPERCLIP_DOCKER_WRAPPER:-/usr/local/bin/docker}"
network_name="paperclip-bridge-smoke-$$"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-docker-build-smoke.XXXXXX")"

cleanup() {
  rm -rf "$build_dir"
  "$DOCKER_BIN" network rm "$network_name" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

"$DOCKER_BIN" info >/dev/null
"$DOCKER_BIN" network create "$network_name" >/dev/null
"$DOCKER_BIN" network inspect "$network_name" >/dev/null

cat > "$build_dir/Dockerfile" <<'EOF'
FROM alpine:3.23
RUN apk add --no-cache ca-certificates >/dev/null
EOF

"$DOCKER_WRAPPER" build -q "$build_dir" >/dev/null

echo "docker lease-readiness smoke ok: daemon, inner network, and tiny package-repository build are available"
