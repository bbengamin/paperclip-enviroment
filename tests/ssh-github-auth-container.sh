#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${PAPERCLIP_SSH_TEST_IMAGE:-paperclip-environment:ssh-github-auth-test}"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-gh-auth-container.XXXXXX")"
container="paperclip-gh-auth-test-$$"
baseline='TEST_BASELINE_TOKEN'

cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    docker logs "$container" >&2 2>/dev/null || true
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
  -e DOCKER_RUNTIME=off \
  -e SSH_UID=10000 \
  -e SSH_GID=10000 \
  -e SSH_GITHUB_TOKEN="$baseline" \
  -v "$test_dir/id_ed25519.pub:/run/authorized_keys:ro" \
  -p 127.0.0.1::22 \
  "$image" >/dev/null

port="$(docker port "$container" 22/tcp | awk -F: 'END { print $NF }')"
ssh_args=(
  -i "$test_dir/id_ed25519"
  -p "$port"
  -o BatchMode=yes
  -o ConnectTimeout=2
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR
)

for _ in $(seq 1 30); do
  if ssh "${ssh_args[@]}" guest@127.0.0.1 true 2>/dev/null; then
    break
  fi
  sleep 1
done
ssh "${ssh_args[@]}" guest@127.0.0.1 true

# One-shot and interactive shells both receive the OpenSSH user environment.
ssh "${ssh_args[@]}" guest@127.0.0.1 \
  'test "$GITHUB_TOKEN" = TEST_BASELINE_TOKEN && test -z "${GH_TOKEN+x}"'
ssh -tt "${ssh_args[@]}" guest@127.0.0.1 \
  'bash -ic '\''test "$GITHUB_TOKEN" = TEST_BASELINE_TOKEN && test -z "${GH_TOKEN+x}"'\''' </dev/null >/dev/null

# Model the explicit env Paperclip adds after SSH profile loading.
ssh "${ssh_args[@]}" guest@127.0.0.1 \
  'env GITHUB_TOKEN=TEST_RUNTIME_GITHUB_TOKEN sh -c '\''test "$GITHUB_TOKEN" = TEST_RUNTIME_GITHUB_TOKEN'\'''
ssh "${ssh_args[@]}" guest@127.0.0.1 \
  'env GH_TOKEN=TEST_RUNTIME_GH_TOKEN sh -c '\''test "$GH_TOKEN" = TEST_RUNTIME_GH_TOKEN && test "$GITHUB_TOKEN" = TEST_BASELINE_TOKEN'\'''

ssh "${ssh_args[@]}" guest@127.0.0.1 \
  'command -v gh >/dev/null && test "$(git config --system --get-all credential.https://github.com.helper)" = "!/usr/bin/gh auth git-credential"'

echo 'SSH GitHub auth container checks passed'
