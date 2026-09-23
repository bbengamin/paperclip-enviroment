#!/usr/bin/env bash
set -euo pipefail

APPS_ENV="${APPS_ENV:-/tmp/paperclip-tooling/apps.env}"
if [ ! -f "$APPS_ENV" ]; then
  echo "tooling manifest not found: $APPS_ENV" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$APPS_ENV"

# Install the standalone Composio CLI into the immutable worker image. Login
# and agent-plugin setup remain per-user/runtime concerns and must not run while
# building the image.
COMPOSIO_INSTALL_DIR="${COMPOSIO_INSTALL_DIR:-/usr/local/lib/composio}"
COMPOSIO_BIN_DIR="${COMPOSIO_BIN_DIR:-/usr/local/bin}"
COMPOSIO_CLI_VERSION="${COMPOSIO_CLI_VERSION:-latest}"

export COMPOSIO_INSTALL_DIR COMPOSIO_BIN_DIR
export COMPOSIO_INSTALL_SHELL=none
export COMPOSIO_INSTALL_PLUGINS=0

if [ "$COMPOSIO_CLI_VERSION" = "latest" ]; then
  curl -fsSL https://composio.dev/install | sh
else
  curl -fsSL https://composio.dev/install | sh -s -- "$COMPOSIO_CLI_VERSION"
fi

command -v composio >/dev/null 2>&1
composio --version
