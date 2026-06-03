FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NPM_CONFIG_PREFIX=/usr/local

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        npm \
        openssh-server \
        ripgrep \
        xz-utils \
    && npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai \
    && curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup --skip-browser \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/run/sshd

COPY entrypoint.sh /entrypoint.sh

RUN chmod 755 /entrypoint.sh

EXPOSE 22

ENTRYPOINT ["/entrypoint.sh"]
