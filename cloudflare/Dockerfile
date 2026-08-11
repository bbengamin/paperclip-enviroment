FROM docker.io/cloudflare/sandbox:0.12.3-musl AS cloudflare-sandbox

FROM docker:dind-rootless

USER root

ENV NPM_CONFIG_PREFIX=/usr/local
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PAPERCLIP_CLOUDFLARE_DOCKER_NETWORK_MODE=build-host

COPY --from=cloudflare-sandbox /container-server/sandbox /sandbox
# cloudflared powers sandbox.tunnels.* (quick-tunnel preview URLs). The base
# musl sandbox image ships a static cloudflared at /usr/local/bin/cloudflared
# that runs as-is on this Alpine (docker:dind-rootless) image.
COPY --from=cloudflare-sandbox /usr/local/bin/cloudflared /usr/local/bin/cloudflared

# Populated from the repo-level tooling source by:
#   npm run sync:tooling
# The predeploy/predev scripts run it automatically before Wrangler builds.
COPY .docker-tooling /tmp/paperclip-tooling
COPY scripts/install-cloudflare-dind-tools.sh /tmp/paperclip-tooling/install-cloudflare-dind-tools.sh

RUN sed -i 's/\r$//' /tmp/paperclip-tooling/*.sh \
  && chmod 755 /tmp/paperclip-tooling/*.sh \
  && /tmp/paperclip-tooling/install-cloudflare-dind-tools.sh \
  && rm -rf /tmp/paperclip-tooling

COPY tailscale-up.sh /usr/local/bin/tailscale-up
COPY boot-docker-for-dind.sh /home/rootless/boot-docker-for-dind.sh
COPY docker-host-network-wrapper.sh /usr/local/bin/docker-host-network-wrapper
COPY docker-runtime-smoke.sh /usr/local/bin/docker-runtime-smoke
# Preview app supervisor (repo-root script, synced into the build context by
# scripts/sync-tooling.mjs). Lets an agent idempotently start/adopt/stop the
# preview server on a reused sandbox instead of hunting stale listeners.
COPY .docker-tooling/paperclip-preview /usr/local/bin/paperclip-preview
RUN sed -i 's/\r$//' /usr/local/bin/paperclip-preview && chmod +x /usr/local/bin/paperclip-preview
RUN sed -i 's/\r$//' /usr/local/bin/tailscale-up /home/rootless/boot-docker-for-dind.sh /usr/local/bin/docker-runtime-smoke \
  && if [ ! -e /usr/local/bin/docker-real ]; then mv /usr/local/bin/docker /usr/local/bin/docker-real; fi \
  && mv /usr/local/bin/docker-host-network-wrapper /usr/local/bin/docker \
  && chmod +x /usr/local/bin/docker \
  && chmod +x /usr/local/bin/tailscale-up \
  && chmod +x /usr/local/bin/docker-runtime-smoke \
  && chmod +x /home/rootless/boot-docker-for-dind.sh \
  && mkdir -p /home/rootless/.docker-run /workspace \
  && chmod 700 /home/rootless/.docker-run \
  && chown -R rootless:rootless /home/rootless \
  && chown -R rootless:rootless /workspace

WORKDIR /workspace

ENTRYPOINT ["/sandbox"]
CMD ["/home/rootless/boot-docker-for-dind.sh"]
