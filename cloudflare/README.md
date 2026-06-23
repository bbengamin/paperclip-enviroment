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
iptables-based networking. Prefer host networking for nested Docker commands:

```bash
docker build --network=host -t app .
docker run --network=host --rm app
docker compose --project-name paperclip up
```

Images and containers created inside a Cloudflare sandbox are ephemeral and may
be lost when the sandbox sleeps or is destroyed.

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
