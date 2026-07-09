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

Preview links need **no extra Worker secrets** — the in-sandbox agent opens a
Cloudflare quick tunnel with the baked-in `cloudflared` (see "Preview links"
below). `PREVIEW_SIGNING_SECRET` / `PAPERCLIP_PREVIEW_BASE_URL` are no longer
required for Cloudflare previews.

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

The bridge injects only `PAPERCLIP_PREVIEW_ENVIRONMENT_TYPE=cloudflare` into every
`/exec` sandbox environment, so the `preview-handoff` skill knows to open a
quick tunnel. Confirm the deploy exposes `bridgeVersion` >= `0.4.1` with
`previewHoldSeconds`, `acquireReuseColdStartRecreate`, and `previewAgentTunnels`
via `GET /health`.

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

Agents produce browser-clickable preview links for the app running inside a
sandbox (via the company `preview-handoff` skill). End-to-end flow:

- **Per-task sandbox.** With `reuseLease` on, the sandbox is keyed by the issue
  (`pc-env-<env>-i-<hash(issueId)>`), so the same task reuses its own sandbox
  across runs while a different task gets a different one.
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

- **Full pages via a per-preview origin (agent-run quick tunnel).** The agent
  verifies the app port, then opens a Cloudflare **quick tunnel** by running
  `cloudflared` directly in the container (`paperclip-preview tunnel --port <p>`,
  which launches it detached and prints the `https://<random>.trycloudflare.com`
  URL). It posts that URL. Because each preview is served on **its own origin**,
  root-absolute assets (`/logo.webp`, `/_nuxt/...`) and in-app navigation "just
  work," and **multiple concurrent previews across projects don't collide** — no
  cookie, no same-origin proxy, no bridge round-trip.
  - This runs `cloudflared` **in the container**, not via the SDK's
    `sandbox.tunnels.*` — that API needs the RPC (capnweb) transport, and
    switching a sandbox's transport mid-run would drop the agent's in-flight exec
    (which is on the default HTTP transport). Running the binary directly avoids
    that entirely. `cloudflared` is baked into the image (copied from the base),
    and the helper forces `--protocol http2` since QUIC/UDP is often blocked.

Cloudflare container disk is **ephemeral**: a sandbox cannot sleep and wake with
its workspace or app process intact — the next start has a fresh disk from the
image. The quick tunnel is a `cloudflared` process **inside** the container, so
it dies when the sandbox sleeps at the end of the preview hold (≈1h). The tunnel
URL is an **unauthenticated public capability** (unguessable, bounded to the hold
window) — no login required. For authenticated preview URLs, use `exposePort` +
a custom domain with wildcard DNS (a future step). The deployed Worker URL is the
Paperclip bridge API and is **not** involved in serving previews.

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
