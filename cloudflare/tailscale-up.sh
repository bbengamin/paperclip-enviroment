#!/bin/sh
set -eu

if [ -z "${TAILSCALE_AUTHKEY:-}" ]; then
  echo "TAILSCALE_AUTHKEY must be set" >&2
  exit 1
fi

mkdir -p /var/lib/tailscale /var/run/tailscale /var/log

if ! pgrep tailscaled >/dev/null 2>&1; then
  tailscaled \
    --state=/var/lib/tailscale/tailscaled.state \
    --tun=userspace-networking \
    --socks5-server=127.0.0.1:1055 \
    --outbound-http-proxy-listen=127.0.0.1:1056 >/var/log/tailscaled.log 2>&1 &
fi

while [ ! -S /var/run/tailscale/tailscaled.sock ]; do
  sleep 1
done

tailscale up \
  --authkey="${TAILSCALE_AUTHKEY}" \
  --hostname="${TAILSCALE_HOSTNAME:-cloudflare-paperclip-sandbox}" \
  ${TAILSCALE_EXTRA_ARGS:-}
