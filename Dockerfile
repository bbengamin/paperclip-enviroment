FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NPM_CONFIG_PREFIX=/usr/local

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        nano \
        npm \
        openssh-server \
        ripgrep \
        xz-utils \
    && npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/run/sshd

# Install rootless Docker-in-Docker (each environment runs its own dockerd as
# the SSH user, no shared host socket). docker-ce-rootless-extras ships
# dockerd-rootless.sh + rootlesskit; uidmap/slirp4netns/fuse-overlayfs/
# dbus-user-session provide the user-namespace, networking and storage plumbing.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
        https://download.docker.com/linux/ubuntu noble stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        docker-ce \
        docker-ce-cli \
        docker-ce-rootless-extras \
        docker-buildx-plugin \
        docker-compose-plugin \
        uidmap \
        slirp4netns \
        fuse-overlayfs \
        dbus-user-session \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh

RUN chmod 755 /entrypoint.sh

EXPOSE 22

ENTRYPOINT ["/entrypoint.sh"]
