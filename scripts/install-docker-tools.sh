#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND="${DEBIAN_FRONTEND:-noninteractive}"
INCLUDE_DOCKER_DAEMON="${INCLUDE_DOCKER_DAEMON:-0}"

. /etc/os-release

install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" >/etc/apt/sources.list.d/docker.list

apt-get update

PACKAGES=(
  docker-ce-cli
  docker-buildx-plugin
  docker-compose-plugin
)

if [ "$INCLUDE_DOCKER_DAEMON" = "1" ]; then
  PACKAGES+=(
    docker-ce
    containerd.io
    docker-ce-rootless-extras
    dbus-user-session
    fuse-overlayfs
    iptables
    slirp4netns
    uidmap
  )
fi

apt-get install -y --no-install-recommends "${PACKAGES[@]}"

