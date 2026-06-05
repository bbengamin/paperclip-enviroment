FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NPM_CONFIG_PREFIX=/usr/local

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bubblewrap \
        ca-certificates \
        curl \
        git \
        nano \
        npm \
        openssh-server \
        ripgrep \
        xz-utils \
    # Docker Engine + CLI + Compose/Buildx plugins and the rootless extras.
    # The environment runs its OWN rootless dockerd (Docker-in-Docker), so each
    # worker gets an isolated, self-owned daemon instead of sharing the host
    # socket. uidmap/slirp4netns/fuse-overlayfs are the rootless runtime deps.
    # See entrypoint.sh and the README "Docker access" section.
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        docker-ce \
        docker-ce-cli \
        containerd.io \
        docker-buildx-plugin \
        docker-compose-plugin \
        docker-ce-rootless-extras \
        dbus-user-session \
        fuse-overlayfs \
        iptables \
        slirp4netns \
        uidmap \
    && npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai \
    && ln -sf /usr/bin/bwrap /usr/local/bin/bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/run/sshd

COPY entrypoint.sh /entrypoint.sh

RUN chmod 755 /entrypoint.sh

EXPOSE 22

ENTRYPOINT ["/entrypoint.sh"]
