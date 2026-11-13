# Gram's server and web app on Linux, for a machine that isn't Linux (Docker Desktop on Windows or
# macOS) or a cluster later. The agents, git and terminals run inside the container; you open the
# web app from the machine's browser through a port mapped to its loopback.
#
#   docker compose -f docker/compose.yaml up --build
#
# See docs/DOCKER.md.
#
# Two images come out of this file. The default target is the one above: the server and the web
# app. `--target host` is the worker host alone, for a machine that only runs another Gram's work
# (docs/PACKAGES.md#images).

# The full image builds: it has the compilers node-pty needs. The slim one runs.
ARG BUILD_IMAGE=node:26.13.0-bookworm
ARG NODE_IMAGE=node:26.13.0-bookworm-slim

FROM ${BUILD_IMAGE} AS build
RUN npm install -g bun@1.4.4
WORKDIR /opt/gram
COPY . .
RUN bun install --frozen-lockfile

# The worker host as a folder that runs on its own: one bundle and its two native modules, built
# here where the compilers are.
FROM build AS host-build
RUN node tools/packages/build-host.mjs /opt/gram-host \
  && cd /opt/gram-host \
  && npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force

FROM build AS server-build
RUN bun run --filter @gram/web build

# What both images run on: the tools threads use, the agents, and the user they run as.
FROM ${NODE_IMAGE} AS runtime
# What threads use beside the agents: git for checkouts, ripgrep for search, ssh for remotes,
# lsof and procps for the port chips and busy terminals, tini to reap what the agents leave.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git lsof openssh-client procps ripgrep tini \
  && rm -rf /var/lib/apt/lists/*
# The GitHub CLI, for Clone from GitHub, pull requests and their checks: its release tarball for
# this architecture, checked against the release's checksums. An empty GH_VERSION leaves it out.
ARG GH_VERSION=2.103.3
RUN if [ -n "${GH_VERSION}" ]; then \
    set -e; \
    arch="$(dpkg --print-architecture)"; \
    name="gh_${GH_VERSION}_linux_${arch}"; \
    base="https://github.com/cli/cli/releases/download/v${GH_VERSION}"; \
    cd /tmp; \
    curl -fsSLO "${base}/${name}.tar.gz"; \
    curl -fsSL "${base}/gh_${GH_VERSION}_checksums.txt" | grep " ${name}.tar.gz\$" | sha256sum -c -; \
    tar -xzf "${name}.tar.gz" -C /usr/local --strip-components=1 "${name}/bin/gh"; \
    rm "${name}.tar.gz"; \
  fi
# The agents Gram runs, from npm. Codex only when CODEX_VERSION is set.
ARG CLAUDE_CODE_VERSION=2.1.319
ARG CODEX_VERSION=
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && if [ -n "${CODEX_VERSION}" ]; then npm install -g "@openai/codex@${CODEX_VERSION}"; fi \
  && npm cache clean --force
RUN useradd --create-home --uid 10001 gram

# The worker host alone. It listens on nothing: it dials the Gram it joined (docs/MACHINES.md), so
# join once with `gram-host join` and keep /home/gram on a volume. /opt/gram-host is the whole
# host, and can be copied into another image of this architecture that has Node.
FROM runtime AS host
# Owned by root: the agents run as gram and can't rewrite the host they run under.
COPY --from=host-build /opt/gram-host /opt/gram-host
RUN printf '#!/bin/sh\nexec node /opt/gram-host/gram-host.js "$@"\n' > /usr/local/bin/gram-host \
  && chmod 755 /usr/local/bin/gram-host
USER gram
WORKDIR /home/gram
ENV GRAM_HOST_HOME=/home/gram/.gram-host
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["gram-host", "run"]

# The server and the web app: the default target.
FROM runtime AS control-plane
# Chromium, for the agent browser on the server (docs/DOCKER.md#the-agent-browser). An empty
# CHROMIUM leaves it out, and agents' browser tools then say the server's browser can't start.
ARG CHROMIUM=1
RUN if [ -n "${CHROMIUM}" ]; then \
    apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*; \
  fi
# Owned by root: the agents run as gram and can't rewrite the server they run under.
COPY --from=server-build /opt/gram /opt/gram
USER gram
WORKDIR /home/gram
# All interfaces inside the container only (`GRAM_CONTAINER`); the port mapping decides who reaches
# it, and requests still need a loopback Host and the launch cookie.
ENV GRAM_CONTAINER=1 \
  GRAM_LISTEN_HOST=0.0.0.0 \
  GRAM_PORT=4317 \
  GRAM_WEB_ROOT=/opt/gram/apps/web/dist \
  GRAM_DATA_DIR=/home/gram/.gram-state \
  GRAM_FAKE_AGENT=0 \
  GRAM_HEADLESS_BROWSER=/opt/gram/packages/shell/src/modules/agent-browser/headless-host.ts \
  GRAM_BROWSER_EXECUTABLE=/usr/bin/chromium \
  GRAM_BROWSER_SANDBOX=0
EXPOSE 4317
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/gram/packages/server/src/main.ts"]
