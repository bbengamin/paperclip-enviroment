FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NPM_CONFIG_PREFIX=/usr/local
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY tooling/apps.env /tmp/paperclip-tooling/apps.env
COPY scripts/install-common-tools.sh scripts/install-docker-tools.sh scripts/install-tailscale.sh /tmp/paperclip-tooling/

RUN chmod 755 /tmp/paperclip-tooling/*.sh \
    && INSTALL_APT_NPM=1 /tmp/paperclip-tooling/install-common-tools.sh \
    && INCLUDE_DOCKER_DAEMON=1 /tmp/paperclip-tooling/install-docker-tools.sh \
    && /tmp/paperclip-tooling/install-tailscale.sh \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        openssh-server \
        openssl \
        passwd \
        util-linux \
    && rm -rf /var/lib/apt/lists/* /tmp/paperclip-tooling \
    && mkdir -p /var/run/sshd

ENV NODE_PATH=/usr/local/lib/node_modules

COPY entrypoint.sh /entrypoint.sh
COPY scripts/preview-gateway.mjs /usr/local/bin/paperclip-preview-gateway.mjs
COPY scripts/paperclip-preview-configure /usr/local/bin/paperclip-preview-configure

RUN chmod 755 /entrypoint.sh /usr/local/bin/paperclip-preview-gateway.mjs /usr/local/bin/paperclip-preview-configure

EXPOSE 22 3999

ENTRYPOINT ["/entrypoint.sh"]
