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
Confirm the deploy exposes `bridgeVersion` >= `0.3.4` with
`previewSigningConfigured`, `previewBaseUrlConfigured`, `previewHoldSeconds`,
`acquireReuseColdStartRecreate`, and `previewCookieSession` via `GET /health`.

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

- **Full pages (cookie-pinned session).** A signed link authorizes only the
  top-level request; a real page then fetches CSS/JS/images at absolute
  origin-root paths (e.g. `/logo.webp`, `/_nuxt/...`) that carry neither the
  preview route prefix nor the `pc_*` signature. On a valid signed request the
  bridge sets a signed, httpOnly, `SameSite=None` cookie (`pc_preview`, scoped to
  `/`, expiring with the link) that pins the browser to `{lease, port}`. Any
  later request outside the bridge API namespace that carries it is proxied to
  the pinned sandbox using its full path. This is framework-agnostic. Limitation:
  one preview per browser at a time (the cookie pins a single sandbox+port); live
  HMR websockets are not proxied yet, so dev-mode hot reload may not work.

Cloudflare container disk is **ephemeral**: a sandbox cannot sleep and wake with
its workspace or app process intact — the next start has a fresh disk from the
image. Signed preview links are therefore valid only while the sandbox is warm
and within the link's expiry (default 1h). The deployed Worker URL is the
Paperclip bridge API; it does not affect Docker build or container egress.

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
