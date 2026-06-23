#!/usr/bin/env sh
set -eu

APPS_ENV="${APPS_ENV:-/tmp/paperclip-tooling/apps.env}"

if [ ! -f "$APPS_ENV" ]; then
  echo "tooling manifest not found: $APPS_ENV" >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$APPS_ENV"

export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-/usr/local}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"

apk add --no-cache \
  bash \
  bubblewrap \
  ca-certificates \
  chromium \
  coreutils \
  curl \
  findutils \
  git \
  iproute2 \
  nano \
  nodejs \
  npm \
  procps \
  ripgrep \
  tailscale \
  tar \
  xz

npm install -g \
  "${CLAUDE_NPM_PACKAGE}@${CLAUDE_VERSION}" \
  "${CODEX_NPM_PACKAGE}@${CODEX_VERSION}" \
  "${OPENCODE_NPM_PACKAGE}@${OPENCODE_VERSION}" \
  "${PLAYWRIGHT_NPM_PACKAGE}@${PLAYWRIGHT_VERSION}"

mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"

if command -v chromium-browser >/dev/null 2>&1; then
  ln -sf "$(command -v chromium-browser)" /usr/local/bin/chromium
fi

if command -v bwrap >/dev/null 2>&1; then
  ln -sf /usr/bin/bwrap /usr/local/bin/bubblewrap
fi
