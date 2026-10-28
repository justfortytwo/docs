# Toolchains copied from their official images (pinned)
FROM docker.io/library/node:22.23.2-bookworm-slim AS node
FROM ghcr.io/astral-sh/uv:0.12.20 AS uv

FROM debian:bookworm-slim

# Bump and rebuild to update (auto-update is disabled in the container)
ARG CLAUDE_CODE_VERSION=2.1.296
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55

# Base workstation tools for Claude Code and MCP/tool execution.
# Keep this image useful for general software work, but don't include
# privileged infrastructure clients or browsers by default.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      ripgrep \
      fd-find \
      jq \
      nano \
      vim-tiny \
      less \
      tree \
      file \
      unzip \
      zip \
      rsync \
      patch \
      tmux \
      procps \
      psmisc \
      lsof \
      iproute2 \
      iputils-ping \
      dnsutils \
      netcat-openbsd \
      sqlite3 \
      python3 \
      openssh-client \
      build-essential \
      pkg-config \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# ttyd (web terminal) is not packaged in bookworm: pinned static release binary
RUN curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64 \
    && echo "${TTYD_SHA256}  /usr/local/bin/ttyd" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/ttyd

# Node 22 LTS + npm/npx, uv/uvx
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=uv /uv /uvx /usr/local/bin/

# Debian's /etc/profile resets PATH in login shells (tmux windows): re-add
# the global npm/uv bin dirs there too
RUN printf '%s\n' 'export PATH="$HOME/.tools/bin:$HOME/.tools/npm/bin:$PATH"' > /etc/profile.d/claude-tools.sh

RUN useradd --create-home --uid 1000 --shell /bin/bash claude \
    && mkdir -p /workspace /home/claude/.claude /home/claude/.tools \
    && chown claude:claude /workspace /home/claude/.claude /home/claude/.tools

USER claude
# Installing from / can hang; use a writable working directory
WORKDIR /tmp
RUN curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CODE_VERSION} \
    && /home/claude/.local/bin/claude --version

# Global installs and caches live in the claude_tools volume (~/.tools);
# project installs (node_modules, .venv) live in /workspace
ENV PATH=/home/claude/.tools/bin:/home/claude/.tools/npm/bin:/home/claude/.local/bin:$PATH \
    NPM_CONFIG_PREFIX=/home/claude/.tools/npm \
    NPM_CONFIG_CACHE=/home/claude/.tools/cache/npm \
    UV_CACHE_DIR=/home/claude/.tools/cache/uv \
    UV_TOOL_DIR=/home/claude/.tools/uv/tools \
    UV_TOOL_BIN_DIR=/home/claude/.tools/bin \
    UV_PYTHON_INSTALL_DIR=/home/claude/.tools/uv/python \
    UV_LINK_MODE=copy \
    CLAUDE_CONFIG_DIR=/home/claude/.claude \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    DISABLE_FEEDBACK_COMMAND=1 \
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1

WORKDIR /workspace
EXPOSE 7681
# Web terminal attached to the shared tmux session "main" (same one as
# `podman exec -it claude-code tmux new -A -s main claude`). -W writable,
# -O rejects cross-origin websockets. No auth: expose it only on a trusted network.
CMD ["ttyd", "-W", "-O", "-p", "7681", "-t", "titleFixed=Claude Code", "tmux", "new", "-A", "-s", "main", "claude"]
