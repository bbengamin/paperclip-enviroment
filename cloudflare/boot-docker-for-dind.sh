#!/usr/bin/env sh
set -eu

mkdir -p /home/rootless/.local/share/docker /home/rootless/.docker /home/rootless/.docker-run /tmp

if [ "$(id -u)" = "0" ]; then
  export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"
else
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/home/rootless/.docker-run}"
  export DOCKER_HOST="${DOCKER_HOST:-unix://$XDG_RUNTIME_DIR/docker.sock}"
fi

dockerd-entrypoint.sh dockerd --iptables=false --ip6tables=false &
dockerd_pid="$!"

until docker version >/dev/null 2>&1; do
  if ! kill -0 "$dockerd_pid" >/dev/null 2>&1; then
    wait "$dockerd_pid"
    exit $?
  fi
  sleep 0.2
done

wait "$dockerd_pid"
