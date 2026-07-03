# Cloudflare Sandbox Bridge

This folder deploys the Paperclip Cloudflare sandbox bridge with Wrangler. The
container image uses the same installed-app manifest as the classic SSH image
and boots rootless Docker-in-Docker inside the Cloudflare sandbox container.

## Required Secrets

Set these Worker secrets before deploy:

```bash
npx wrangler secret put BRIDGE_AUTH_TOKEN
npx wrangler secret put TAILSCALE_AUTHKEY
```

`TAILSCALE_AUTHKEY` is required. Lease setup fails without it because all
Cloudflare sandbox commands are expected to run with tailnet/private-network
access available.

Optional Worker secrets:

```bash
npx wrangler secret put TAILSCALE_HOSTNAME
npx wrangler secret put TAILSCALE_EXTRA_ARGS
```

## Deploy

```bash
npm ci
npm test
npm run typecheck
npm run deploy
```

`npm run deploy` first syncs the repo-level tooling scripts into this folder's
Docker build context, then runs `wrangler deploy`.

## Docker-In-Docker

Cloudflare sandbox commands can run Docker commands inside the environment. The
image follows Cloudflare's documented rootless Docker-in-Docker pattern:

- base image: `docker:dind-rootless`
- Cloudflare sandbox runtime copied from `cloudflare/sandbox:0.12.1-musl`
- entrypoint: `/sandbox`
- command: `/home/rootless/boot-docker-for-dind.sh`

Nested Docker is rootless and must not rely on privileged containers or
iptables-based bridge NAT. Cloudflare's Docker-in-Docker guidance requires
host networking for traffic in and out of inner Docker containers, so the image
defaults nested Docker commands to host networking:

```bash
docker build --network=host -t app .
docker run --network=host --rm app
docker compose --project-name paperclip up
```

The Cloudflare image installs a small Docker CLI wrapper that defaults nested
`docker build`, `docker buildx build`, `docker run`, and common
`docker compose` execution paths to host networking. Set
`PAPERCLIP_CLOUDFLARE_DOCKER_HOST_NETWORK=0` inside a sandbox command only when
you deliberately want to bypass the wrapper and test normal Docker networking.

Lease setup also runs a quick Docker startup smoke test:

```bash
docker-runtime-smoke
```

The smoke test calls the real Docker CLI directly, verifies `docker info`, and
checks host-network DNS/package-repository egress with both Alpine and Debian
build containers. If Cloudflare cannot resolve package repositories from inner
Docker builds, the lease fails early instead of letting an agent discover the
problem deep inside a project `docker compose up`.

## Preview URLs

The deployed Worker URL is for the Paperclip bridge API. It does not affect
Docker build or container egress.

For future application previews on a `workers.dev` deployment, prefer
`sandbox.tunnels.get(port)` because it creates a Cloudflare Tunnel URL without
requiring wildcard DNS. Use `sandbox.exposePort(port, { hostname })` only after
the bridge is deployed on a custom domain that supports wildcard preview
hostnames.

Images and containers created inside a Cloudflare sandbox are ephemeral and may
be lost when the sandbox sleeps or is destroyed.

## Preview Proxy

The bridge can proxy HTTP requests from the Worker to a running sandbox port:

```text
https://<bridge-host>/api/paperclip-sandbox/v1/preview/<providerLeaseId>/<port>/<path>
```

Example:

```text
https://paperclip-cloudflare-sandbox-bridge.example.workers.dev/api/paperclip-sandbox/v1/preview/pc-env-.../27451/
```

The preview proxy uses Cloudflare's container request forwarding rather than a
public container IP. Requests must include the bridge bearer token; the bridge
removes that `Authorization` header before forwarding the request to the
sandboxed app.

Browser-clickable preview links may use the shared signed preview URL contract
instead of a bearer header:

```text
https://<bridge-host>/api/paperclip-sandbox/v1/preview/<providerLeaseId>/<port>/<path>?pc_issue=<issue>&pc_run=<run>&pc_exp=<unix>&pc_sig=<sig>
```

Signed preview URLs use `HMAC-SHA256` with the `paperclip-preview-v1` canonical
payload from `RL-1405`. The Worker verifies signatures with the
`PREVIEW_SIGNING_SECRET` secret, derives the target from
`providerLeaseId`, rejects expired or invalid links before resolving the
sandbox, and strips signing query parameters plus bridge auth headers before
forwarding to the sandboxed app.

Non-preview bridge routes remain bearer-token only. Cloudflare preview links are
still operationally temporary: even a valid signature can stop working when the
sandbox sleeps or is destroyed.

## GitHub Actions Deployment

The Cloudflare bridge workflow validates pull requests and deploys
automatically after changes are merged to `main`.

Configure these repository secrets:

| Secret | Required | Purpose |
|---|---:|---|
| `CLOUDFLARE_API_TOKEN` | yes | Non-interactive Wrangler authentication |
| `CLOUDFLARE_ACCOUNT_ID` | recommended | Selects the target account explicitly in CI |

For a local dry-run check:

```bash
npm run deploy:dry-run
```

## Paperclip Configuration

Configure the Paperclip Cloudflare sandbox environment with:

| Field | Value |
|---|---|
| `bridgeBaseUrl` | The deployed Worker root URL |
| `bridgeAuthToken` | Same value as the Worker's `BRIDGE_AUTH_TOKEN` secret |

Do not put `TAILSCALE_AUTHKEY` in Paperclip. It stays Worker-side.
