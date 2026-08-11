#!/bin/sh
set -eu

# gh prefers GH_TOKEN to GITHUB_TOKEN. An SSH session starts with the same
# baseline in both variables, but Paperclip may explicitly override only
# GITHUB_TOKEN for a run. In that case, discard only the inherited GH_TOKEN so
# the runtime-provided GITHUB_TOKEN wins. The baseline token itself is never
# embedded in this launcher or Git configuration.
baseline_sha256="${PAPERCLIP_SSH_GITHUB_TOKEN_SHA256:-}"
if [ -n "$baseline_sha256" ] && [ "${GH_TOKEN+x}" = x ] && [ "${GITHUB_TOKEN+x}" = x ]; then
  gh_sha256="$(printf '%s' "$GH_TOKEN" | sha256sum | cut -d ' ' -f 1)"
  github_sha256="$(printf '%s' "$GITHUB_TOKEN" | sha256sum | cut -d ' ' -f 1)"
  if [ "$gh_sha256" = "$baseline_sha256" ] && [ "$github_sha256" != "$baseline_sha256" ]; then
    unset GH_TOKEN
  fi
fi

exec "${GH_REAL_BIN:-/usr/bin/gh}" "$@"
