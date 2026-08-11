# Paperclip environment: classic SSH and Cloudflare sandbox

This repo is the source of truth for two Paperclip environment deployment
modes:

- **Classic Docker / SSH**: the existing Docker Compose flow that exposes SSH
  into a persistent Ubuntu environment.
- **Cloudflare sandbox**: a Wrangler-deployed Worker bridge and Cloudflare
  sandbox container under `cloudflare/`.

Both modes share installed app/tool policy through `tooling/apps.env` and the
installer scripts in `scripts/`. See `tooling/README.md` before changing Codex,
Claude, opencode, Playwright, Docker, or Tailscale installation.

## Deployment paths

Classic Docker / SSH:

```bash
docker compose up -d --build
```

Cloudflare sandbox:

```bash
cd cloudflare
npm ci
npm test
npm run typecheck
npm run deploy
```

Cloudflare requires Worker secrets `BRIDGE_AUTH_TOKEN` and `TAILSCALE_AUTHKEY`.
The old standalone Cloudflare sandbox image repo can be deleted after this repo
passes local Docker and Wrangler deployment tests.

## Classic Docker / SSH

This container gives remote users shell access to an Ubuntu 24.04 container on this machine.

## What it does

- runs `sshd` in an Ubuntu container
- accepts public-key auth only
- exposes container SSH on host port `2222`, bound to the Tailscale IP only
- provides `/workspace` as a dedicated Paperclip runtime volume
- mounts this environment repo at `/environment` as read-only reference material
- includes `claude`, `codex`, and `opencode` CLIs in the image
- includes GitHub CLI with token-backed HTTPS Git authentication for SSH sessions
- includes Playwright with Chromium preinstalled for browserless testing

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

## GitHub authentication for SSH workers

The classic SSH worker can provide a baseline GitHub token to every guest SSH
session, including one-shot commands. This is useful for unattended clones,
fetches, and pushes over HTTPS. The baseline is exposed as `GITHUB_TOKEN` only,
so Paperclip's project- or agent-level `GH_TOKEN` or `GITHUB_TOKEN` naturally
takes precedence for managed runs. When both runtime variables are present,
GitHub CLI keeps its normal `GH_TOKEN` preference.

### Prerequisites and deployment

1. Create a least-privilege GitHub token for the repositories the baseline
   worker identity must access. Prefer a fine-grained token with an expiry.
2. Keep the deployment `.env` uncommitted and readable only by its owner:

   ```bash
   chmod 600 .env
   ```

3. Set the host-side secret in `.env` (never in `.env.example`):

   ```dotenv
   SSH_GITHUB_TOKEN=<github-token>
   ```

4. Rebuild and recreate the SSH service:

   ```bash
   docker compose up -d --build --force-recreate ubuntu-ssh
   ```

The entrypoint projects the secret into the guest SSH environment as
`GITHUB_TOKEN`. The token itself is not written to Git credential files or Git
remote URLs. Git uses `gh auth git-credential` through system configuration.

### Verification

Avoid commands such as `env`, `set`, `docker compose config`, `echo
$GH_TOKEN`, or `echo $GITHUB_TOKEN`, which can disclose a credential. Instead,
verify presence and auth without printing it:

```bash
ssh -p 2222 guest@<host> 'test -n "$GITHUB_TOKEN"'
ssh -p 2222 guest@<host> 'gh auth status >/dev/null'
ssh -p 2222 guest@<host> 'git config --get-all credential.https://github.com.helper'
```

Verify an interactive shell separately, without displaying either value:

```console
$ ssh -p 2222 guest@<host>
guest@worker:~$ test -n "$GITHUB_TOKEN"
guest@worker:~$ gh auth status >/dev/null
guest@worker:~$ exit
```

Run the deterministic, synthetic-token precedence check from the repository:

```bash
./tests/ssh-github-auth.sh
```

For a Paperclip run with an explicit token, verify `gh auth status >/dev/null`
inside that run. An explicit `GITHUB_TOKEN` replaces the inherited baseline,
while an explicit `GH_TOKEN` wins through GitHub CLI's normal precedence.

GitHub CLI's credential helper applies to HTTPS remotes. Existing checkouts
whose origin is `git@github.com:OWNER/REPO.git` continue to use SSH keys and do
not use this token. Switch only the affected repository to a credential-free
HTTPS URL:

```bash
git remote set-url origin https://github.com/OWNER/REPO.git
```

Never add a token to that URL.

### Rotation, rollback, and security

To rotate the baseline, replace `SSH_GITHUB_TOKEN` in `.env` and recreate the
service. To disable or roll back token projection, remove or empty the variable
and recreate the service. Startup then removes the managed `GITHUB_TOKEN` entry
from `~/.ssh/environment`, deleting the file only when no unrelated entries remain.
Existing Paperclip-provided run tokens remain independent.

The baseline is available to every process running as the SSH guest and is
stored mode `0600` in the persisted guest home for OpenSSH to load. It is also
present in the container's configured environment, so anyone with host Docker
control can retrieve it. Treat Docker-host access and the guest account as
trusted for the token's scope, use least privilege and expiry, protect `.env`
with mode `0600`, and rotate the token after suspected exposure. Do not enable
shell tracing around container startup or authentication commands.

## Signed Preview Gateway

The classic SSH environment also starts a small signed HTTP preview gateway for
operator browser checks. Docker Compose publishes it on the same private
`HOST_BIND_IP` used for SSH:

```text
http://<tailscale-name-or-ip>:3999/preview/<environmentId>/<port>/<path>?pc_issue=<issue>&pc_run=<run>&pc_exp=<unix>&pc_sig=<sig>
```

Set these values in `.env`:

```bash
PAPERCLIP_PREVIEW_GATEWAY_HOST_PORT=3999
PAPERCLIP_PREVIEW_GATEWAY_ENABLED=1
PAPERCLIP_PREVIEW_ENVIRONMENT_ID=<optional-stable-environment-id>
PREVIEW_SIGNING_SECRET=<optional-boot-time-shared-preview-secret>
PAPERCLIP_PREVIEW_SIGNING_SECRET_FILE=/run/paperclip-preview/signing-secret
PAPERCLIP_PREVIEW_ALLOWED_PORTS=3000,3001,4000,4200,5000,5173,5174,8000,8080,9000
# Optional. Left unset, docker-compose derives it from HOST_BIND_IP + the
# published gateway port.
PAPERCLIP_PREVIEW_BASE_URL=<optional-public-origin-e.g-http://100.x.y.z:3999>
```

The gateway verifies `HMAC-SHA256` signatures using the shared
`paperclip-preview-v1` canonical payload. It derives the target from the URL
path, requires it to match the gateway's canonical target, rejects expired or
invalid signatures before proxying, and forwards only HTTP requests to
`127.0.0.1` on the configured allowed preview ports. The canonical target is
published by:

```text
http://127.0.0.1:3999/.well-known/paperclip-preview
```

The metadata response includes `target`, `routePrefix`, and `baseUrl` (the
operator-facing origin). Sign links against `baseUrl` + `routePrefix` and use
the `target` value instead of guessing an environment id or a host.

`PREVIEW_SIGNING_SECRET` is required for signed preview links. If it
is missing, preview requests fail with `preview_signing_unavailable`, but SSH
and unrelated agent task execution still start normally. Because Paperclip run
secrets can arrive after the container and gateway process have already started,
the gateway also reads the secret from
`PAPERCLIP_PREVIEW_SIGNING_SECRET_FILE` on every request. Agents can publish
their run-time secret to that file and read gateway metadata with:

```bash
paperclip-preview-configure
```

This command uses the agent's `PREVIEW_SIGNING_SECRET`, writes it to the
runtime secret file, and prints the `.well-known/paperclip-preview` metadata.
It keeps the operator contract to one manually configured secret:
`PREVIEW_SIGNING_SECRET`.

The default allowed preview ports are:

```text
3000, 3001, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 9000
```

Do not expose the preview gateway on a public interface. Keep `HOST_BIND_IP`
set to the machine's Tailscale IP or another private operator-only interface.
The gateway does not scan ports and does not proxy arbitrary hosts, SSH, Docker,
database/admin ports, private files, or non-HTTP TCP services.

Manual smoke path:

1. Start an HTTP app inside the SSH environment on an allowed port, for example
   `5173`.
2. Generate a signed URL using the shared contract from `RL-1405` with
   `target=<target from /.well-known/paperclip-preview>`, the task issue id,
   run id, port, and expiry.
3. Open the URL from a browser connected to the same Tailscale network.
4. Confirm the app opens and that invalid, expired, wrong-target, and disallowed
   port URLs are rejected.

### Preview app supervisor (`paperclip-preview`)

Both images install `paperclip-preview`, a small idempotent supervisor for the
preview app process. It exists because agents often re-enter a warm environment
— a persistent SSH container, or a reused/held Cloudflare sandbox — where a
preview server they started earlier is still running; without a record, they
waste steps rediscovering ports and killing stale listeners. It records the
running app in a manifest (`/tmp/paperclip-preview.json`) so re-entry is a status
check, not a hunt:

```bash
paperclip-preview status                 # is a preview already serving?
paperclip-preview start --port 3001 -- npm run dev -- --host 0.0.0.0 --port 3001
paperclip-preview stop
```

`start` adopts the port if it already serves HTTP; otherwise it launches the
command detached (`setsid`/`nohup`) so it survives the run session, then waits
for the port. On the persistent SSH environment the manifest persists with the
container; on Cloudflare it lives on ephemeral disk and clears when the sandbox
sleeps (which is fine — after sleep there is no app to reconcile).

## Included CLIs

These are installed globally and available in the shell:

```bash
node --version
npm --version
claude --version
codex --version
opencode --version
playwright --version
```

Most of them still need their API keys or local config after login.

## Browserless testing

The image includes the Playwright CLI and a preinstalled Chromium browser at
`/ms-playwright`, exposed through `PLAYWRIGHT_BROWSERS_PATH`. This lets coding
agents run quick browser smoke tests without first downloading a browser.

Examples:

```bash
playwright --version
playwright install --dry-run chromium
```

Project test suites should still declare their own test runner dependency, for
example `@playwright/test`, when they need Playwright fixtures, assertions, or
project-specific config.

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

## Docker access (Docker-in-Docker, rootless)

The container runs its **own** Docker daemon so workers can build and run
containers from inside the SSH environment. It uses **rootless dockerd**: the
daemon runs as the unprivileged SSH user inside a user namespace, not as host
root, and the host Docker socket is **not** mounted.

Why rootless DinD instead of mounting the host socket (Docker-outside-of-Docker):

- **Isolation between workers.** Each environment has its own daemon, so
  `docker ps` only shows that worker's containers — workers can't inspect,
  exec into, or kill each other's (or the host's) containers.
- **Self-owned containers.** Containers and volumes you create live inside this
  environment, and `docker run -v` paths resolve against the environment's
  filesystem, not the host's.
- **No host-root exposure.** There is no `/var/run/docker.sock` bind mount, so
  the SSH user cannot use the Docker socket to take over the host.

### How it works

- The image installs the full Docker engine, CLI, Compose/Buildx plugins,
  `iproute2`, and
  the rootless extras (`docker-ce-rootless-extras`, `uidmap`, `slirp4netns`,
  `fuse-overlayfs`).
- `entrypoint.sh` adds `subuid`/`subgid` ranges for the SSH user, then starts
  `dockerd-rootless.sh` in the background as that user. The daemon listens on a
  per-user socket at `unix:///run/user/<uid>/docker.sock` and stores data under
  `~/.local/share/docker` (persisted in the `guest-home` volume).
- `DOCKER_HOST` and `XDG_RUNTIME_DIR` are exported to SSH sessions via
  `/etc/profile.d/docker-rootless.sh`, so `docker` just works after login.
- `docker-compose.yml` grants the outer environment container the namespace and
  network permissions rootless dockerd needs, including `/dev/net/tun` for
  `slirp4netns`.
- On Docker Desktop, the service also runs with `privileged: true`; without it,
  the daemon can start but nested `docker run` may fail when `runc` mounts
  `/proc`.

Daemon startup is **non-fatal**: if Docker can't start on a given host, SSH
access still comes up. Check `/var/log/dockerd-rootless.log` in the container to
diagnose.

### Verify from inside the container

```bash
docker version          # Client and Server should both report
docker info | grep -i 'rootless\|storage driver'
docker run --rm hello-world
docker compose version
```

### Configuration

Set the runtime mode in `.env`:

```bash
DOCKER_RUNTIME=rootless   # default; use "off" to disable Docker startup
```

### Host requirements and fallbacks

Rootless dockerd needs the host kernel to allow unprivileged user namespaces
(true on most modern Linux hosts and inside the Docker Desktop VM). This Compose
setup also expects `/dev/net/tun` so `slirp4netns` can create its TAP device.
The daemon uses `overlayfs` when supported; if your host requires
`fuse-overlayfs`, add `/dev/fuse` to the service.

If the daemon fails to start on a stricter Linux host, alternatives to compare
against the Docker Desktop-oriented default are:

1. Add the `/dev/fuse` device for `fuse-overlayfs` storage if overlayfs is not
   available.
2. Run the service with the [sysbox](https://github.com/nestybox/sysbox) runtime
   (`runtime: sysbox-runc`) for stronger isolation without `unconfined`.

## Add other users

By default, `.env.example` points `AUTHORIZED_KEYS_SOURCE` at `./authorized_keys`.
Put one or more public keys in that file, one key per line, or change the path in `.env`.

## Notes

- The SSH access is to the container, not the macOS host.
- `/workspace` is a dedicated Paperclip runtime volume. Configure Paperclip SSH environments to use it as `remoteWorkspacePath`; do not put this environment repo or a project checkout there directly.
- This environment repo is mounted read-only at `/environment` for inspection and debugging.
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
