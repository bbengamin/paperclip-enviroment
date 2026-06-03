#!/usr/bin/env bash
set -euo pipefail

SSH_USER="${SSH_USER:-guest}"
SSH_UID="${SSH_UID:-1000}"
SSH_GID="${SSH_GID:-1000}"
AUTHORIZED_KEYS_FILE="${AUTHORIZED_KEYS_FILE:-/run/authorized_keys}"
HOST_KEYS_DIR="${HOST_KEYS_DIR:-/hostkeys}"
SSH_HOME="/home/${SSH_USER}"

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
X11Forwarding no
PrintMotd no
Subsystem sftp /usr/lib/openssh/sftp-server
EOF

exec /usr/sbin/sshd -D -e
