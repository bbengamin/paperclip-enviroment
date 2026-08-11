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
        gh \
        openssh-server \
        openssl \
        passwd \
        util-linux \
    && rm -rf /var/lib/apt/lists/* /tmp/paperclip-tooling \
    && mkdir -p /var/run/sshd

ENV NODE_PATH=/usr/local/lib/node_modules

RUN mkdir -p /usr/local/libexec

COPY scripts/gh-with-token-precedence.sh /usr/local/bin/gh
COPY scripts/project-ssh-github-env.sh /usr/local/libexec/project-ssh-github-env
COPY entrypoint.sh /entrypoint.sh

RUN chmod 755 /entrypoint.sh /usr/local/bin/gh /usr/local/libexec/project-ssh-github-env \
    && git config --system credential.https://github.com.helper '!/usr/local/bin/gh auth git-credential' \
    && git config --system credential.https://gist.github.com.helper '!/usr/local/bin/gh auth git-credential'

EXPOSE 22

ENTRYPOINT ["/entrypoint.sh"]
