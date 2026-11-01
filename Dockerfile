# syntax=docker/dockerfile:1
#
# Claude Code sandbox: a Debian image with Claude Code, Node.js, Python, git and
# the GitHub CLI, running as an unprivileged user. See README.md.
#
#   docker build --build-arg CLAUDE_CODE_VERSION=stable -t claude-sandbox .

ARG DEBIAN_RELEASE=trixie

# ---------------------------------------------------------------------------
# fetch: download and verify the Claude Code binary and Node.js
# ---------------------------------------------------------------------------
FROM debian:${DEBIAN_RELEASE}-slim AS fetch
SHELL ["/bin/bash", "-Eeuo", "pipefail", "-c"]

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg jq xz-utils \
 && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
# A version number (for example 2.1.309), or the channel `stable` or `latest`.
ARG CLAUDE_CODE_VERSION=stable
# Fingerprint of the Claude Code release signing key, as published at
# https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing
ARG CLAUDE_CODE_RELEASE_FINGERPRINT=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
WORKDIR /tmp/claude
RUN case "$TARGETARCH" in \
      amd64) platform=linux-x64 ;; \
      arm64) platform=linux-arm64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    base=https://downloads.claude.ai/claude-code-releases; \
    version="$CLAUDE_CODE_VERSION"; \
    if [[ $version == stable || $version == latest ]]; then version="$(curl -fsSL "$base/$version")"; fi; \
    [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad Claude Code version: $version" >&2; exit 1; }; \
    GNUPGHOME="$(mktemp -d)"; export GNUPGHOME; \
    curl -fsSL https://downloads.claude.ai/keys/claude-code.asc | gpg --batch --quiet --import; \
    gpg --batch --with-colons --fingerprint | awk -F: '$1 == "fpr" { print $10 }' | grep -qx "$CLAUDE_CODE_RELEASE_FINGERPRINT"; \
    curl -fsSLO "$base/$version/manifest.json"; \
    curl -fsSLO "$base/$version/manifest.json.sig"; \
    gpg --batch --verify manifest.json.sig manifest.json; \
    checksum="$(jq -er --arg p "$platform" '.platforms[$p].checksum' manifest.json)"; \
    curl -fsSL "$base/$version/$platform/claude" -o claude; \
    echo "$checksum  claude" | sha256sum -c -; \
    install -D -m 0755 claude /out/claude; \
    echo "$version" > /out/VERSION

ARG NODE_MAJOR=24
WORKDIR /tmp/node
RUN case "$TARGETARCH" in \
      amd64) arch=x64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"; \
    curl -fsSLO "$base/SHASUMS256.txt"; \
    tarball="$(grep -oE "node-v[0-9.]+-linux-${arch}\.tar\.xz" SHASUMS256.txt | head -n1)"; \
    curl -fsSLO "$base/$tarball"; \
    grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -; \
    mkdir -p /opt/node; \
    tar -xJf "$tarball" -C /opt/node --strip-components=1 --no-same-owner; \
    rm -rf /opt/node/include /opt/node/share/doc /opt/node/share/man /opt/node/CHANGELOG.md /opt/node/README.md

# ---------------------------------------------------------------------------
# final image
# ---------------------------------------------------------------------------
FROM debian:${DEBIAN_RELEASE}-slim
SHELL ["/bin/bash", "-Eeuo", "pipefail", "-c"]

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    DEBIAN_FRONTEND=noninteractive

# Docker Engine is installed but only runs with CLAUDE_DOCKER=1 in a privileged
# container (compose.docker.yaml).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash-completion build-essential ca-certificates chromium curl bind9-dnsutils fd-find file \
      fonts-liberation git git-lfs gnupg gosu iputils-ping jq less nano openssh-client pipx pkgconf \
      procps psmisc python3 python3-pip python3-venv ripgrep rsync shellcheck sudo tini tmux tree \
      unzip vim-tiny wget xz-utils zip zstd \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
 && chmod +x /usr/sbin/policy-rc.d \
 && apt-get install -y --no-install-recommends gh \
      apparmor containerd.io docker-buildx-plugin docker-ce docker-ce-cli docker-compose-plugin \
 && rm -f /usr/sbin/policy-rc.d \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd

# Chromium's own sandbox can't start in an unprivileged container: the
# container is the sandbox. See docker/chromium-flags.sh.
COPY --chmod=0644 docker/chromium-flags.sh /etc/chromium.d/claude-sandbox

COPY --from=fetch /opt/node /opt/node
RUN for bin in node npm npx corepack; do \
      if [ -e "/opt/node/bin/$bin" ]; then ln -s "/opt/node/bin/$bin" "/usr/local/bin/$bin"; fi; \
    done

ARG CLAUDE_UID=1000
ARG CLAUDE_GID=1000
# hadolint ignore=SC2016
RUN groupadd --gid "$CLAUDE_GID" claude \
 && useradd --uid "$CLAUDE_UID" --gid claude --create-home --shell /bin/bash claude \
 && install -d -o claude -g claude -m 0755 /workspace /home/claude/.local /home/claude/.local/bin \
 && install -d -o claude -g claude -m 0700 /home/claude/.claude \
 && printf 'prefix=/home/claude/.local\n' > /home/claude/.npmrc \
 && printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> /home/claude/.bashrc \
 && printf '%s\n' '# Settings saved from the web UI' \
      '[ -r /usr/local/lib/claude-sandbox/settings.sh ] && . /usr/local/lib/claude-sandbox/settings.sh && claude_sandbox_load_settings' \
      >> /home/claude/.bashrc \
 && chown claude:claude /home/claude/.npmrc /home/claude/.bashrc \
 && usermod -aG docker claude \
 && git config --system --add safe.directory '*' \
 && git config --system init.defaultBranch main

COPY --from=fetch /out/ /usr/local/lib/claude-code/
COPY --chmod=0755 docker/claude-wrapper.sh /usr/local/bin/claude
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/claude-sandbox
# Web UI (server mode) and the settings it saves; see README.md, "Web UI".
COPY --chmod=0644 docker/settings.sh /usr/local/lib/claude-sandbox/settings.sh
COPY --chmod=0755 docker/with-settings.sh /usr/local/lib/claude-sandbox/with-settings
COPY docker/webui/ /usr/local/lib/claude-sandbox/webui/
RUN chmod -R a+rX,go-w /usr/local/lib/claude-sandbox

# The image is versioned by tag; Claude Code updates arrive with new images.
# CHROME_* and PUPPETEER_* point browser tooling at the system Chromium.
ENV CLAUDE_CONFIG_DIR=/home/claude/.claude \
    CLAUDE_WORKDIR=/workspace \
    DISABLE_AUTOUPDATER=1 \
    CHROME_BIN=/usr/bin/chromium \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

ARG CLAUDE_CODE_VERSION=stable
LABEL org.opencontainers.image.title="Claude Code sandbox" \
      org.opencontainers.image.description="Sandboxed Claude Code environment: local terminal, Remote Control for claude.ai/code and the Claude app with a web UI to set it up, or a self-hosted runner" \
      io.github.claude-sandbox.claude-code-version="${CLAUDE_CODE_VERSION}"

# Web UI, served in `server` mode (CLAUDE_WEBUI_PORT).
EXPOSE 8765
WORKDIR /workspace
# The entrypoint starts as root only to match UIDs, fix volume ownership and,
# with CLAUDE_DOCKER, start Docker, then drops to the `claude` user for
# everything else.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/claude-sandbox"]
CMD ["auto"]
