#!/bin/sh
set -eu

if [ -z "${TAILSCALE_AUTHKEY:-}" ]; then
  echo "TAILSCALE_AUTHKEY must be set" >&2
  exit 1
fi

TAILSCALE_STATE_DIR="${TAILSCALE_STATE_DIR:-${HOME:-/tmp}/.tailscale}"
TAILSCALE_SOCKET="${TAILSCALE_SOCKET:-${TAILSCALE_STATE_DIR}/tailscaled.sock}"
TAILSCALE_LOG="${TAILSCALE_LOG:-${TAILSCALE_STATE_DIR}/tailscaled.log}"

mkdir -p "$TAILSCALE_STATE_DIR"

if ! pgrep tailscaled >/dev/null 2>&1; then
  tailscaled \
    --socket="$TAILSCALE_SOCKET" \
    --state="${TAILSCALE_STATE_DIR}/tailscaled.state" \
    --tun=userspace-networking \
    --socks5-server=127.0.0.1:1055 \
    --outbound-http-proxy-listen=127.0.0.1:1056 >"$TAILSCALE_LOG" 2>&1 &
fi

while [ ! -S "$TAILSCALE_SOCKET" ]; do
  sleep 1
done

tailscale --socket="$TAILSCALE_SOCKET" up \
  --authkey="${TAILSCALE_AUTHKEY}" \
  --hostname="${TAILSCALE_HOSTNAME:-cloudflare-paperclip-sandbox}" \
  ${TAILSCALE_EXTRA_ARGS:-}
