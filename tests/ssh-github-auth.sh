#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
projector="$repo_root/scripts/project-ssh-github-env.sh"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-gh-auth-test.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT

baseline='TEST_BASELINE_TOKEN'
runtime_gh='TEST_RUNTIME_GH_TOKEN'
runtime_github='TEST_RUNTIME_GITHUB_TOKEN'
ssh_home="$test_dir/home"

mkdir -p "$ssh_home/.ssh"
SSH_HOME="$ssh_home" SSH_UID="$(id -u)" SSH_GID="$(id -g)" SSH_GITHUB_TOKEN="$baseline" "$projector"
environment_file="$ssh_home/.ssh/environment"
test "$(stat -c '%a' "$environment_file" 2>/dev/null || stat -f '%Lp' "$environment_file")" = 600
grep -Fqx "GITHUB_TOKEN=$baseline" "$environment_file"
if grep -Eq '^(GH_TOKEN|PAPERCLIP_SSH_GITHUB_TOKEN_SHA256)=' "$environment_file"; then
  echo 'projector wrote an unmanaged GitHub environment variable' >&2
  exit 1
fi

printf 'PAPERCLIP_UNRELATED=value\n' >>"$environment_file"
SSH_HOME="$ssh_home" SSH_UID="$(id -u)" SSH_GID="$(id -g)" SSH_GITHUB_TOKEN= "$projector"
grep -Fqx 'PAPERCLIP_UNRELATED=value' "$environment_file"
test "$(wc -l <"$environment_file" | tr -d ' ')" = 1
test -z "$(find "$ssh_home/.ssh" -name '.environment.*' -print -quit)"

if SSH_HOME="$ssh_home" SSH_UID="$(id -u)" SSH_GID="$(id -g)" SSH_GITHUB_TOKEN=$'invalid\ntoken' \
  "$projector" >/dev/null 2>&1; then
  echo 'newline-containing token unexpectedly accepted' >&2
  exit 1
fi
grep -Fqx 'PAPERCLIP_UNRELATED=value' "$environment_file"

# The SSH baseline supplies only GITHUB_TOKEN. Paperclip's explicit remote env
# therefore overrides it directly, while an explicit GH_TOKEN naturally keeps
# GitHub CLI's documented higher precedence.
GITHUB_TOKEN="$baseline" env GITHUB_TOKEN="$runtime_github" sh -c \
  'test "$GITHUB_TOKEN" = TEST_RUNTIME_GITHUB_TOKEN && test -z "${GH_TOKEN+x}"'
GITHUB_TOKEN="$baseline" env GH_TOKEN="$runtime_gh" sh -c \
  'test "$GH_TOKEN" = TEST_RUNTIME_GH_TOKEN && test "$GITHUB_TOKEN" = TEST_BASELINE_TOKEN'
GITHUB_TOKEN="$baseline" env GH_TOKEN="$runtime_gh" GITHUB_TOKEN="$runtime_github" sh -c \
  'test "$GH_TOKEN" = TEST_RUNTIME_GH_TOKEN && test "$GITHUB_TOKEN" = TEST_RUNTIME_GITHUB_TOKEN'

git_config="$test_dir/gitconfig"
git config --file "$git_config" credential.https://github.com.helper '!/usr/bin/gh auth git-credential'
grep -Fqx $'\thelper = !/usr/bin/gh auth git-credential' "$git_config"
if grep -Fq "$baseline" "$git_config"; then
  echo 'baseline token unexpectedly persisted in Git credential configuration' >&2
  exit 1
fi

echo 'SSH GitHub auth projection and precedence checks passed'
