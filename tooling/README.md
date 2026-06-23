# Installed Apps And Tools

`tooling/apps.env` is the source of truth for agent apps and version policy.
Both deployment modes consume it through the installer scripts in `scripts/`.

| Tool | Classic Docker / SSH | Cloudflare sandbox | Version policy | Purpose | Change here |
|---|---:|---:|---|---|---|
| Codex CLI | yes | yes | `CODEX_VERSION` | Paperclip `codex_remote` runs | `tooling/apps.env` |
| Claude Code CLI | yes | yes | `CLAUDE_VERSION` | Claude-based agent runs | `tooling/apps.env` |
| opencode CLI | yes | yes | `OPENCODE_VERSION` | opencode-based agent runs | `tooling/apps.env` |
| Playwright CLI + Chromium | yes | yes | `PLAYWRIGHT_VERSION`, `PLAYWRIGHT_BROWSER` | Browser smoke tests | `tooling/apps.env` |
| Docker CLI | yes | yes | Docker apt repository stable channel / `docker:dind-rootless` | Build/run tooling entrypoint | `scripts/install-docker-tools.sh`, `cloudflare/Dockerfile` |
| Docker Compose v2 | yes | yes | Docker apt repository stable channel / `docker:dind-rootless` | Compose workflows | `scripts/install-docker-tools.sh`, `cloudflare/Dockerfile` |
| Docker Buildx | yes | yes | Docker apt repository stable channel / `docker:dind-rootless` | Image builds | `scripts/install-docker-tools.sh`, `cloudflare/Dockerfile` |
| Rootless dockerd | yes | yes | Docker apt repository stable channel / `docker:dind-rootless` | Isolated Docker daemon for agent workloads | `scripts/install-docker-tools.sh`, `entrypoint.sh`, `cloudflare/boot-docker-for-dind.sh` |
| Tailscale | yes | yes | Tailscale apt repository stable channel / Alpine package | Tailnet/private provider access | `scripts/install-tailscale.sh`, `cloudflare/scripts/install-cloudflare-dind-tools.sh` |

Both deployment modes provide rootless Docker for agent workloads. The classic
Docker deployment starts rootless dockerd from `entrypoint.sh`; the Cloudflare
sandbox image follows Cloudflare's Docker-in-Docker guidance by using
`docker:dind-rootless`, copying in the Cloudflare sandbox runtime, and starting
`dockerd` from `cloudflare/boot-docker-for-dind.sh`.
