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

For browser-clickable signed preview links, also set:

```bash
# HMAC secret the Worker verifies signed preview URLs with. Missing => the
# preview route answers 503 preview_signing_unavailable.
npx wrangler secret put PREVIEW_SIGNING_SECRET
# Public origin of this bridge, e.g.
# https://paperclip-cloudflare-sandbox-bridge.<account>.workers.dev
# Can be a var or secret; the bridge reads it from the Worker env.
npx wrangler secret put PAPERCLIP_PREVIEW_BASE_URL
```

Optional preview hold tuning:

```bash
# Idle window (seconds) a reused preview sandbox is kept before it is allowed to
# sleep after a run completes. Default 3600 (1h). On lease release the bridge
# arms this as the sandbox `sleepAfter` (and drops keepAlive), so a held preview
# sandbox scales to zero — disk wiped, instance slot + billing freed — after
# this much inactivity instead of living forever. A later run on the same task
# renews activity and resets the timer.
npx wrangler secret put PREVIEW_HOLD_SECONDS   # or set as a plain var
```

Recommended env config for preview-heavy Cloudflare environments: **`reuseLease`
on** (sandbox keyed per task, survives task completion for review) and
**`keepAlive` on** (active runs never sleep mid-run). The bridge converts the
sandbox to the bounded hold window on release regardless of the keepAlive toggle,
so held sandboxes always self-clean.

The bridge forwards `PAPERCLIP_PREVIEW_BASE_URL`, the `providerLeaseId` (as the
signing target), the `cloudflare` environment type, and `PREVIEW_SIGNING_SECRET`
into every `/exec` sandbox environment. Worker vars/secrets do not otherwise
cross into the container, so this injection is what lets the in-sandbox agent
build a signed preview URL against the real bridge host. Because the same Worker
secret is used to both sign (injected) and verify, the two copies cannot drift.
Confirm the deploy exposes `bridgeVersion` >= `0.4.0` with
`previewSigningConfigured`, `previewBaseUrlConfigured`, `previewHoldSeconds`,
`acquireReuseColdStartRecreate`, and `previewTunnels` via `GET /health`.

If a **reuse** lease hits a cold-start wedge during setup (e.g. the SDK's
`/tmp/session-*` watch `ENOENT` race on a slept/re-acquired container), the
acquire loop now tears the sandbox down and recreates it fresh under the same
deterministic id instead of re-polling the wedge until the budget runs out. A
healthy reattach re-runs setup idempotently and is unaffected.

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

## Preview links

Agents produce browser-clickable **signed** preview links for the app running
inside a sandbox (via the company `preview-handoff` skill). End-to-end flow:

- **Per-task sandbox.** With `reuseLease` on, the sandbox is keyed by the issue
  (`pc-env-<env>-i-<hash(issueId)>`), so the same task reuses its own sandbox
  across runs while a different task gets a different one.
- **Authoritative link inputs.** The bridge injects `PAPERCLIP_PREVIEW_BASE_URL`
  (this Worker's public origin), the `providerLeaseId` (signing target), the
  `cloudflare` environment type, and `PREVIEW_SIGNING_SECRET` into every `/exec`
  environment (see [Required Secrets](#required-secrets)). The agent signs against
  those instead of guessing a host.
- **Serving the app.** The `paperclip-preview` helper baked into the image starts
  or adopts the app process idempotently and records it in a manifest, so a
  re-entering agent reconciles state instead of hunting stale listeners. See the
  root `README.md` "Preview app supervisor" section.
- **1-hour hold.** When the task finishes, the reused sandbox is retained (not
  destroyed) but switched to a bounded idle window (`PREVIEW_HOLD_SECONDS`,
  default 1h) instead of living forever under keepAlive. The operator can review
  the PR and open the live preview; a follow-up "make changes" run reattaches to
  the same warm sandbox and resets the window. After the idle window the
  container sleeps — on Cloudflare that scales it to zero and frees the instance
  slot + billing. A later run then cold-starts a fresh sandbox and the agent
  re-provisions from the branch.

- **Full pages via a per-preview origin (quick tunnel).** The agent verifies the
  app port, then calls the bridge's `preview-tunnel` endpoint; the bridge opens a
  Cloudflare **quick tunnel** for that sandbox port (`sandbox.tunnels.get(port)`)
  and returns its `https://<random>.trycloudflare.com` URL, which the agent posts.
  Because each preview is served on **its own origin**, root-absolute assets
  (`/logo.webp`, `/_nuxt/...`) and in-app navigation "just work," and **multiple
  concurrent previews across projects don't collide** — no cookie, no
  same-origin proxy. Requires `cloudflared` in the image (copied from the base).

Cloudflare container disk is **ephemeral**: a sandbox cannot sleep and wake with
its workspace or app process intact — the next start has a fresh disk from the
image. The quick tunnel is a `cloudflared` process **inside** the container, so
it dies when the sandbox sleeps at the end of the preview hold (≈1h). The tunnel
URL is an **unauthenticated public capability** (unguessable, bounded to the hold
window) — creating it requires a bearer or signed request, but the resulting URL
needs no login. For authenticated preview URLs, use `exposePort` + a custom
domain with wildcard DNS (a future step). The deployed Worker URL is the
Paperclip bridge API; it does not affect Docker build or container egress.

## Preview tunnel endpoint

The agent opens a preview by requesting a quick tunnel for a running port. Bearer
callers (the adapter) are trusted; in-sandbox agents use a signed request so a
random party cannot open tunnels on our sandboxes:

```text
POST/GET https://<bridge-host>/api/paperclip-sandbox/v1/preview-tunnel/<providerLeaseId>/<port>/?pc_issue=<issue>&pc_run=<run>&pc_exp=<unix>&pc_sig=<sig>
```

The signature uses `HMAC-SHA256` over the `paperclip-preview-v1` canonical payload
(target = `providerLeaseId`); the Worker verifies it, resolves the sandbox, calls
`sandbox.tunnels.get(port)`, and responds:

```json
{ "ok": true, "provider": "cloudflare", "port": 3001, "url": "https://<random>.trycloudflare.com", "hostname": "<random>.trycloudflare.com" }
```

All other bridge routes remain bearer-token only.

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
