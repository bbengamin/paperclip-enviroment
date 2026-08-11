#!/usr/bin/env bash
set -euo pipefail

SSH_USER="${SSH_USER:-guest}"
SSH_UID="${SSH_UID:-1000}"
SSH_GID="${SSH_GID:-1000}"
AUTHORIZED_KEYS_FILE="${AUTHORIZED_KEYS_FILE:-/run/authorized_keys}"
HOST_KEYS_DIR="${HOST_KEYS_DIR:-/hostkeys}"
SSH_HOME="/home/${SSH_USER}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"

if [ ! -f "$AUTHORIZED_KEYS_FILE" ]; then
  echo "authorized keys file not found: $AUTHORIZED_KEYS_FILE" >&2
  exit 1
fi

if ! getent group "$SSH_GID" >/dev/null 2>&1; then
  groupadd --gid "$SSH_GID" "$SSH_USER"
fi

if ! id -u "$SSH_USER" >/dev/null 2>&1; then
  useradd --uid "$SSH_UID" --gid "$SSH_GID" --create-home --shell /bin/bash "$SSH_USER"
fi

# Ubuntu creates the account in a locked state by default. Set a non-usable
# password hash so OpenSSH will allow key-based logins while password auth stays off.
usermod -p "$(openssl passwd -6 disabled-login)" "$SSH_USER"

install -d -m 700 "$SSH_HOME"
chown "$SSH_UID:$SSH_GID" "$SSH_HOME"
install -d -m 700 -o "$SSH_USER" -g "$SSH_GID" "$SSH_HOME/.ssh"
install -m 600 -o "$SSH_USER" -g "$SSH_GID" "$AUTHORIZED_KEYS_FILE" "$SSH_HOME/.ssh/authorized_keys"
for dir in \
  "$SSH_HOME/.claude" \
  "$SSH_HOME/.codex" \
  "$SSH_HOME/.config" \
  "$SSH_HOME/.config/opencode" \
  "$SSH_HOME/.local" \
  "$SSH_HOME/.local/share" \
  "$SSH_HOME/.local/share/opencode" \
  "$SSH_HOME/.local/state" \
  "$SSH_HOME/.local/state/opencode"
do
  install -d -m 700 "$dir"
done

# Make the entire persisted home writable by the SSH user. This handles
# migrated auth/config files regardless of which tool created them.
chown -R "$SSH_UID:$SSH_GID" "$SSH_HOME"
chmod 700 "$SSH_HOME/.ssh"
chmod 600 "$SSH_HOME/.ssh/authorized_keys"

# sshd does not inherit the Compose environment when UsePAM is disabled.
# Project the host-only baseline into OpenSSH's per-user environment so both
# interactive shells and one-shot commands receive it. The managed entries are
# replaced or removed without disturbing unrelated user entries, preventing a
# disabled or rotated baseline from lingering in the persisted guest-home volume.
SSH_HOME="$SSH_HOME" SSH_UID="$SSH_UID" SSH_GID="$SSH_GID" \
  SSH_GITHUB_TOKEN="${SSH_GITHUB_TOKEN:-}" \
  /usr/local/libexec/project-ssh-github-env

# Paperclip uses this directory as the remote runtime root for staged agent
# workspaces. Keep it user-owned and independent from the environment repo.
install -d -m 775 -o "$SSH_UID" -g "$SSH_GID" "$WORKSPACE_DIR"

# --- Docker-in-Docker (rootless) -------------------------------------------
# Give the SSH user an isolated, self-owned Docker daemon instead of sharing
# the host socket. Each environment runs its own rootless dockerd, so workers
# can build and run containers without host-root exposure (no /var/run/docker.sock
# bind mount) and without seeing other workers' containers.
# Controlled by DOCKER_RUNTIME: "rootless" (default) or "off".
DOCKER_RUNTIME="${DOCKER_RUNTIME:-rootless}"
DOCKER_RUN_DIR="/run/user/${SSH_UID}"

if [ "$DOCKER_RUNTIME" = "rootless" ] && command -v dockerd-rootless.sh >/dev/null 2>&1; then
  # subuid/subgid ranges are required for the rootless user-namespace mapping.
  if ! grep -q "^${SSH_USER}:" /etc/subuid 2>/dev/null; then
    echo "${SSH_USER}:100000:65536" >>/etc/subuid
  fi
  if ! grep -q "^${SSH_USER}:" /etc/subgid 2>/dev/null; then
    echo "${SSH_USER}:100000:65536" >>/etc/subgid
  fi

  install -d -m 700 -o "$SSH_UID" -g "$SSH_GID" "$DOCKER_RUN_DIR"
  install -d -m 700 -o "$SSH_UID" -g "$SSH_GID" "$SSH_HOME/.local/share/docker"

  # sshd does not inherit this process's environment (and UsePAM is off, so
  # /etc/environment is not consulted). Publish DOCKER_HOST/XDG_RUNTIME_DIR via
  # a login-shell profile snippet and the system interactive-shell rc so docker
  # works in both `ssh user@host` and `ssh user@host <cmd>` sessions.
  cat >/etc/profile.d/docker-rootless.sh <<EOF
export XDG_RUNTIME_DIR="${DOCKER_RUN_DIR}"
export DOCKER_HOST="unix://${DOCKER_RUN_DIR}/docker.sock"
EOF
  chmod 644 /etc/profile.d/docker-rootless.sh
  touch "$SSH_HOME/.profile"
  if ! grep -q 'docker-rootless.sh' "$SSH_HOME/.profile" 2>/dev/null; then
    echo '[ -f /etc/profile.d/docker-rootless.sh ] && . /etc/profile.d/docker-rootless.sh' >>"$SSH_HOME/.profile"
  fi
  chown "$SSH_UID:$SSH_GID" "$SSH_HOME/.profile"
  chmod 644 "$SSH_HOME/.profile"
  if ! grep -q 'docker-rootless.sh' /etc/bash.bashrc 2>/dev/null; then
    echo '[ -f /etc/profile.d/docker-rootless.sh ] && . /etc/profile.d/docker-rootless.sh' >>/etc/bash.bashrc
  fi

  # Launch the rootless daemon as the SSH user in the background. Failure here
  # is non-fatal on purpose: SSH access must come up even if Docker cannot start
  # (e.g. host blocks the namespaces). Logs land in /var/log/dockerd-rootless.log.
  echo "starting rootless dockerd for ${SSH_USER} (socket ${DOCKER_RUN_DIR}/docker.sock)" >&2
  setpriv --reuid "$SSH_UID" --regid "$SSH_GID" --init-groups \
    env HOME="$SSH_HOME" \
        XDG_RUNTIME_DIR="$DOCKER_RUN_DIR" \
        PATH="/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin" \
        dockerd-rootless.sh >/var/log/dockerd-rootless.log 2>&1 &
elif [ "$DOCKER_RUNTIME" = "rootless" ]; then
  echo "DOCKER_RUNTIME=rootless but dockerd-rootless.sh is not installed; skipping Docker startup" >&2
fi

mkdir -p "$HOST_KEYS_DIR"
chmod 700 "$HOST_KEYS_DIR"

if [ ! -f "$HOST_KEYS_DIR/ssh_host_ed25519_key" ]; then
  ssh-keygen -A
  cp /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key.pub "$HOST_KEYS_DIR/"
  cp /etc/ssh/ssh_host_ecdsa_key /etc/ssh/ssh_host_ecdsa_key.pub "$HOST_KEYS_DIR/"
  cp /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub "$HOST_KEYS_DIR/"
  chmod 600 "$HOST_KEYS_DIR"/ssh_host_*_key
  chmod 644 "$HOST_KEYS_DIR"/ssh_host_*.pub
fi

cat >/etc/ssh/sshd_config <<EOF
Port 22
Protocol 2
HostKey $HOST_KEYS_DIR/ssh_host_rsa_key
HostKey $HOST_KEYS_DIR/ssh_host_ecdsa_key
HostKey $HOST_KEYS_DIR/ssh_host_ed25519_key
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
AllowUsers $SSH_USER
PermitUserEnvironment GH_TOKEN,GITHUB_TOKEN,PAPERCLIP_SSH_GITHUB_TOKEN_SHA256
X11Forwarding no
PrintMotd no
Subsystem sftp /usr/lib/openssh/sftp-server
EOF

exec /usr/sbin/sshd -D -e
