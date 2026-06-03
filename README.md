# Ubuntu SSH container over Tailscale

This container gives remote users shell access to an Ubuntu 24.04 container on this machine.

## What it does

- runs `sshd` in an Ubuntu container
- accepts public-key auth only
- exposes container SSH on host port `2222`, bound to the Tailscale IP only
- mounts this repo at `/workspace` as read-write
- includes `claude`, `codex`, `opencode`, and `hermes` CLIs in the image

## First run

1. Copy `.env.example` to `.env`
2. Set `HOST_BIND_IP` to this machine's Tailscale IP from `tailscale ip -4`
3. Create an `authorized_keys` file in this repo or point `AUTHORIZED_KEYS_SOURCE` at another public key file
4. Start the container:

```bash
docker compose up -d --build
```

## Connect from another machine

Use this machine's Tailscale IP or MagicDNS name:

```bash
ssh -p 2222 guest@<tailscale-name-or-ip>
```

If you change `SSH_USER` in `.env`, use that username instead.

## Included CLIs

These are installed globally and available in the shell:

```bash
claude --version
codex --version
opencode --version
hermes --version
```

Most of them still need their API keys or local config after login.
`hermes` is installed from the official Nous Research installer with setup skipped, so you can run `hermes setup` after login.

## Add other users

By default, `.env.example` points `AUTHORIZED_KEYS_SOURCE` at `./authorized_keys`.
Put one or more public keys in that file, one key per line, or change the path in `.env`.

## Notes

- The SSH access is to the container, not the macOS host.
- The repo is mounted read-write at `/workspace`.
