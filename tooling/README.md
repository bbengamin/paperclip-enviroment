# Installed Apps And Tools

`tooling/apps.env` is the source of truth for agent apps and version policy.
Both deployment modes consume it through the installer scripts in `scripts/`.

| Tool | Classic Docker / SSH | Cloudflare sandbox | Version policy | Purpose | Change here |
|---|---:|---:|---|---|---|
| Codex CLI | yes | yes | `CODEX_VERSION` | Paperclip `codex_remote` runs | `tooling/apps.env` |
| Claude Code CLI | yes | yes | `CLAUDE_VERSION` | Claude-based agent runs | `tooling/apps.env` |
| opencode CLI | yes | yes | `OPENCODE_VERSION` | opencode-based agent runs | `tooling/apps.env` |
| Playwright CLI + Chromium | yes | yes | `PLAYWRIGHT_VERSION`, `PLAYWRIGHT_BROWSER` | Browser smoke tests | `tooling/apps.env` |
| Docker CLI | yes | yes | Docker apt repository stable channel | Build/run tooling entrypoint | `scripts/install-docker-tools.sh` |
| Docker Compose v2 | yes | yes | Docker apt repository stable channel | Compose workflows | `scripts/install-docker-tools.sh` |
| Docker Buildx | yes | yes | Docker apt repository stable channel | Image builds | `scripts/install-docker-tools.sh` |
| Rootless dockerd | yes | no | Docker apt repository stable channel | Isolated Docker daemon for classic SSH | `scripts/install-docker-tools.sh`, `entrypoint.sh` |
| Tailscale | yes | yes | Tailscale apt repository stable channel | Tailnet/private provider access | `scripts/install-tailscale.sh` |

Cloudflare gets Docker CLI/Compose/Buildx for command compatibility, but it
does not require or start a nested Docker daemon. The classic Docker deployment
starts rootless dockerd when `DOCKER_RUNTIME=rootless`.

