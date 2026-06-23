#!/usr/bin/env bash
set -euo pipefail

APPS_ENV="${APPS_ENV:-/tmp/paperclip-tooling/apps.env}"

if [ ! -f "$APPS_ENV" ]; then
  echo "tooling manifest not found: $APPS_ENV" >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$APPS_ENV"

export DEBIAN_FRONTEND="${DEBIAN_FRONTEND:-noninteractive}"
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-/usr/local}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"

apt-get update
PACKAGES=(
  bash
  bubblewrap
  ca-certificates
  coreutils
  curl
  findutils
  git
  iproute2
  nano
  procps
  ripgrep
  tar
  xz-utils
)

if [ "${INSTALL_APT_NPM:-0}" = "1" ]; then
  PACKAGES+=(npm)
fi

apt-get install -y --no-install-recommends "${PACKAGES[@]}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found; set INSTALL_APT_NPM=1 for base images without npm" >&2
  exit 1
fi

npm install -g \
  "${CLAUDE_NPM_PACKAGE}@${CLAUDE_VERSION}" \
  "${CODEX_NPM_PACKAGE}@${CODEX_VERSION}" \
  "${OPENCODE_NPM_PACKAGE}@${OPENCODE_VERSION}" \
  "${PLAYWRIGHT_NPM_PACKAGE}@${PLAYWRIGHT_VERSION}"

mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
npx playwright install --with-deps "${PLAYWRIGHT_BROWSER:-chromium}"
chmod -R 755 "$PLAYWRIGHT_BROWSERS_PATH"

if command -v bwrap >/dev/null 2>&1; then
  ln -sf /usr/bin/bwrap /usr/local/bin/bubblewrap
fi
