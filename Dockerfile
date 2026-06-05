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

# Install Docker CLI + Compose v2 plugin (Docker-outside-of-Docker)
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
        https://download.docker.com/linux/ubuntu noble stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        docker-ce-cli \
        docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh

RUN chmod 755 /entrypoint.sh

EXPOSE 22

ENTRYPOINT ["/entrypoint.sh"]
