# Ubuntu SSH container over Tailscale

This container gives remote users shell access to an Ubuntu 24.04 container on this machine.

## What it does

- runs `sshd` in an Ubuntu container
- accepts public-key auth only
- exposes container SSH on host port `2222`, bound to the Tailscale IP only
- mounts this repo at `/workspace` as read-write
- includes `claude`, `codex`, and `opencode` CLIs in the image

## First run

1. Copy `.env.example` to `.env`
2. Set `HOST_BIND_IP` to this machine's Tailscale IP from `tailscale ip -4`
3. Create an `authorized_keys` file in this repo or point `AUTHORIZED_KEYS_SOURCE` at another public key file
4. Start the container:

```bash
docker compose up -d --build
```

To use a published Docker Hub image instead of building locally:

```bash
docker compose pull
docker compose up -d
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
```

Most of them still need their API keys or local config after login.

### Logging in from Docker

If you log into a CLI with `docker exec` or `docker compose exec`, run it as `guest` so the auth is written to `/home/guest` and survives container recreation.

Open an interactive shell as `guest`:

```bash
docker exec -it --user guest ubuntu-ssh sh
```

Or with Docker Compose:

```bash
docker compose exec --user guest ubuntu-ssh sh
```

Then log in normally, for example:

```bash
cd /workspace
claude login
codex login
```

One-shot examples:

```bash
docker exec -it --user guest ubuntu-ssh sh -lc 'cd /workspace && claude login'
docker compose exec --user guest ubuntu-ssh sh -lc 'cd /workspace && codex login'
```

Avoid logging in as the default `root` user:

```bash
docker exec -it ubuntu-ssh sh
```

That stores auth under `/root`, which is not the persisted working home for the SSH user.

## Docker access (Docker-outside-of-Docker)

The container ships with the Docker CLI and Compose v2 plugin and talks to the
**host** Docker daemon through the bind-mounted host socket. No Docker daemon
runs inside the container.

How it works:

- `docker-ce-cli` and `docker-compose-plugin` are installed in the image
- `docker-compose.yml` bind-mounts `${DOCKER_SOCKET:-/var/run/docker.sock}` to
  `/var/run/docker.sock` and sets `DOCKER_HOST=unix:///var/run/docker.sock`
- `entrypoint.sh` reads the socket's group GID at startup and adds the SSH user
  to a matching group so `docker` works without root

Configure the host socket path in `.env` if your daemon listens elsewhere:

```bash
DOCKER_SOCKET=/var/run/docker.sock
```

Verify from inside the container:

```bash
docker version
docker compose version
docker ps
```

Notes and caveats:

- Containers and volumes you create are managed by the **host** daemon, not the
  container, and paths in `docker run -v` refer to host paths.
- Sharing the Docker socket grants the SSH user effective control of the host
  Docker engine (root-equivalent on the host). Only enable this for trusted
  users.
- On Docker Desktop the socket is often root-owned; the SSH user may need extra
  privileges. The entrypoint logs a warning in that case.

## Add other users

By default, `.env.example` points `AUTHORIZED_KEYS_SOURCE` at `./authorized_keys`.
Put one or more public keys in that file, one key per line, or change the path in `.env`.

## Notes

- The SSH access is to the container, not the macOS host.
- The repo is mounted read-write at `/workspace`.
- The whole guest home is persisted in one Docker named volume mounted at `/home/guest`, so user-level CLI auth and config survive container recreation without host bind-mount ownership quirks.
- `CODEX_HOME` is pinned to `~/.codex` so Codex uses that persisted home directory even when invoked outside an interactive SSH login.
- `nano` is installed in the container.
- `docker compose down` keeps those volumes. `docker compose down -v` deletes them, including the persisted guest home and `/hostkeys`.

## Docker Hub publishing

### GitHub Actions

The repo includes `.github/workflows/docker-publish.yml` to build and push the image to Docker Hub on:

- pushes to `main`
- version tags matching `v*`
- manual runs from `workflow_dispatch`

Configure these GitHub settings before using it:

- repository secret `DOCKERHUB_USERNAME`
- repository secret `DOCKERHUB_TOKEN`

The Docker image name is fixed as `bbengamin/paperclip-enviroment`.

The workflow publishes:

- `latest` on `main`
- a short `sha-...` tag on each build
- the git tag itself for `v*` releases

The GitHub Action builds multi-arch Linux images for:

- `linux/amd64`
- `linux/arm64`

It uses the GitHub Actions cache backend for Docker layer reuse between runs.

### Backup shell script

For manual publishing, use `scripts/docker-build-push.sh`:

```bash
./scripts/docker-build-push.sh
```

Optional arguments:

```bash
./scripts/docker-build-push.sh bbengamin/paperclip-enviroment custom-tag
```

By default, the script pushes `bbengamin/paperclip-enviroment:latest`.
If `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` are set, the script logs in before pushing.
It uses `docker buildx build` by default, builds `linux/amd64` and `linux/arm64`, and reuses Docker registry cache from `bbengamin/paperclip-enviroment:buildcache` automatically.

### Docker Compose build vs pull

`docker-compose.yml` supports both local builds and the published Docker Hub image:

- local build: `docker compose up -d --build`
- pull published image: `docker compose pull && docker compose up -d`

The defaults come from `.env`:

- `DOCKER_IMAGE=bbengamin/paperclip-enviroment`
- `DOCKER_TAG=latest`

You can override the tag when needed, for example:

```bash
DOCKER_TAG=sha-abcdef1 docker compose pull
DOCKER_TAG=sha-abcdef1 docker compose up -d
```
