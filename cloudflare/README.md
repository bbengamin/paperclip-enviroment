# Cloudflare Sandbox Bridge

This folder deploys the Paperclip Cloudflare sandbox bridge with Wrangler. The
container image uses the same installed-app manifest as the classic SSH image.

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

