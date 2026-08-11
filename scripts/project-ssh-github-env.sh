#!/usr/bin/env bash
set -euo pipefail

: "${SSH_HOME:?SSH_HOME is required}"
: "${SSH_UID:?SSH_UID is required}"
: "${SSH_GID:?SSH_GID is required}"

ssh_dir="$SSH_HOME/.ssh"
environment_file="$ssh_dir/environment"
token="${SSH_GITHUB_TOKEN:-}"
environment_tmp="$(mktemp "$ssh_dir/.environment.XXXXXX")"
trap 'rm -f "$environment_tmp"' EXIT

if [ -e "$environment_file" ] || [ -L "$environment_file" ]; then
  if [ -L "$environment_file" ] || [ ! -f "$environment_file" ]; then
    echo "refusing to update unsafe SSH environment path: $environment_file" >&2
    exit 1
  fi
  grep -Ev '^GITHUB_TOKEN=' \
    "$environment_file" >"$environment_tmp" || true
fi

if [ -n "$token" ]; then
  case "$token" in
    *$'\n'*|*$'\r'*)
      echo "SSH_GITHUB_TOKEN must not contain newline characters" >&2
      exit 1
      ;;
  esac

  printf 'GITHUB_TOKEN=%s\n' "$token" >>"$environment_tmp"
fi

if [ -s "$environment_tmp" ]; then
  chmod 600 "$environment_tmp"
  chown "$SSH_UID:$SSH_GID" "$environment_tmp"
  mv -f "$environment_tmp" "$environment_file"
else
  rm -f "$environment_file" "$environment_tmp"
fi
trap - EXIT
