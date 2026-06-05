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
    # Docker CLI + Compose v2 from Docker's official apt repository. Only the
    # client is installed; the daemon is provided by the host via the
    # bind-mounted /var/run/docker.sock (Docker-outside-of-Docker).
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        docker-ce-cli \
        docker-compose-plugin \
    && npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai \
    && ln -sf /usr/bin/bwrap /usr/local/bin/bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/run/sshd

COPY entrypoint.sh /entrypoint.sh

RUN chmod 755 /entrypoint.sh

EXPOSE 22

ENTRYPOINT ["/entrypoint.sh"]
