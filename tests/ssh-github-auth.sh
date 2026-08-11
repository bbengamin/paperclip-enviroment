#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
wrapper="$repo_root/scripts/gh-with-token-precedence.sh"
projector="$repo_root/scripts/project-ssh-github-env.sh"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-gh-auth-test.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT

baseline='TEST_BASELINE_TOKEN'
runtime_gh='TEST_RUNTIME_GH_TOKEN'
runtime_github='TEST_RUNTIME_GITHUB_TOKEN'
baseline_sha256="$(printf '%s' "$baseline" | sha256sum | cut -d ' ' -f 1)"
ssh_home="$test_dir/home"
capture="$test_dir/capture"
fake_gh="$test_dir/gh"

mkdir -p "$ssh_home/.ssh"
SSH_HOME="$ssh_home" SSH_UID="$(id -u)" SSH_GID="$(id -g)" SSH_GITHUB_TOKEN="$baseline" "$projector"
environment_file="$ssh_home/.ssh/environment"
test "$(stat -c '%a' "$environment_file" 2>/dev/null || stat -f '%Lp' "$environment_file")" = 600
grep -Fqx "GH_TOKEN=$baseline" "$environment_file"
grep -Fqx "GITHUB_TOKEN=$baseline" "$environment_file"
grep -Fqx "PAPERCLIP_SSH_GITHUB_TOKEN_SHA256=$baseline_sha256" "$environment_file"

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

cat >"$fake_gh" <<'EOF'
#!/bin/sh
{
  printf 'GH_TOKEN=%s\n' "${GH_TOKEN-<unset>}"
  printf 'GITHUB_TOKEN=%s\n' "${GITHUB_TOKEN-<unset>}"
  printf 'ARGV=%s\n' "$*"
} >"$CAPTURE"
EOF
chmod 700 "$fake_gh"

run_wrapper() {
  CAPTURE="$capture" GH_REAL_BIN="$fake_gh" PAPERCLIP_SSH_GITHUB_TOKEN_SHA256="$baseline_sha256" \
    "$wrapper" auth status
}

GH_TOKEN="$baseline" GITHUB_TOKEN="$baseline" run_wrapper
grep -Fqx "GH_TOKEN=$baseline" "$capture"
grep -Fqx "GITHUB_TOKEN=$baseline" "$capture"

GH_TOKEN="$runtime_gh" GITHUB_TOKEN="$baseline" run_wrapper
grep -Fqx "GH_TOKEN=$runtime_gh" "$capture"
grep -Fqx "GITHUB_TOKEN=$baseline" "$capture"

GH_TOKEN="$baseline" GITHUB_TOKEN="$runtime_github" run_wrapper
grep -Fqx 'GH_TOKEN=<unset>' "$capture"
grep -Fqx "GITHUB_TOKEN=$runtime_github" "$capture"

GH_TOKEN="$runtime_gh" GITHUB_TOKEN="$runtime_github" run_wrapper
grep -Fqx "GH_TOKEN=$runtime_gh" "$capture"
grep -Fqx "GITHUB_TOKEN=$runtime_github" "$capture"
grep -Fqx 'ARGV=auth status' "$capture"

git_config="$test_dir/gitconfig"
git config --file "$git_config" credential.https://github.com.helper '!/usr/local/bin/gh auth git-credential'
grep -Fqx $'\thelper = !/usr/local/bin/gh auth git-credential' "$git_config"
if grep -Fq "$baseline" "$git_config"; then
  echo 'baseline token unexpectedly persisted in Git credential configuration' >&2
  exit 1
fi

echo 'SSH GitHub auth precedence checks passed'
