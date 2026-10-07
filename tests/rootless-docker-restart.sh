#!/usr/bin/env bash
set -euo pipefail

# Rootless dockerd must come back when the container is restarted after an
# unclean stop (host reboot or power loss) that left a docker.pid pointing at a
# PID another process now holds. Requires a Docker host that allows privileged
# containers.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${PAPERCLIP_SSH_TEST_IMAGE:-paperclip-environment:rootless-restart-test}"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-rootless-restart.XXXXXX")"
container="paperclip-rootless-restart-test-$$"
run_dir=/run/user/10000

cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    docker exec "$container" tail -n 20 /var/log/dockerd-rootless.log >&2 2>/dev/null || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$test_dir"
  return "$rc"
}
trap cleanup EXIT

ssh-keygen -q -t ed25519 -N '' -f "$test_dir/id_ed25519"

if [ "${PAPERCLIP_SSH_SKIP_BUILD:-0}" != "1" ]; then
  docker build --quiet -t "$image" "$repo_root" >/dev/null
fi

docker run -d --name "$container" \
  --privileged \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --device /dev/net/tun \
  -e SSH_UID=10000 \
  -e SSH_GID=10000 \
  -v "$test_dir/id_ed25519.pub:/run/authorized_keys:ro" \
  "$image" >/dev/null

wait_for_docker() {
  for _ in $(seq 1 60); do
    if docker exec -u 10000 -e DOCKER_HOST="unix://$run_dir/docker.sock" \
      "$container" docker info >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "rootless dockerd did not come up: $1" >&2
  return 1
}

wait_for_docker "first start"

# PID 1 is always alive after a restart, so this stands in for a stale
# docker.pid that collides with an unrelated process. Stopping the container
# kills dockerd without letting it remove the file.
docker exec "$container" sh -c "echo 1 > $run_dir/docker.pid"
docker restart "$container" >/dev/null

wait_for_docker "after restart with a stale docker.pid"
echo "rootless dockerd restarted with a stale docker.pid"
