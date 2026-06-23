FROM docker.io/cloudflare/sandbox:0.12.1

USER root

ENV DEBIAN_FRONTEND=noninteractive
ENV NPM_CONFIG_PREFIX=/usr/local
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Populated from the repo-level tooling source by:
#   npm run sync:tooling
# The predeploy/predev scripts run it automatically before Wrangler builds.
COPY .docker-tooling /tmp/paperclip-tooling

RUN chmod 755 /tmp/paperclip-tooling/*.sh \
  && /tmp/paperclip-tooling/install-common-tools.sh \
  && /tmp/paperclip-tooling/install-docker-tools.sh \
  && /tmp/paperclip-tooling/install-tailscale.sh \
  && rm -rf /var/lib/apt/lists/* /tmp/paperclip-tooling

COPY tailscale-up.sh /usr/local/bin/tailscale-up
RUN sed -i 's/\r$//' /usr/local/bin/tailscale-up \
  && chmod +x /usr/local/bin/tailscale-up

WORKDIR /workspace

