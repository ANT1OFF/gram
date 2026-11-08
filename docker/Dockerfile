# Gram's server and web app on Linux, for a machine that isn't Linux (Docker Desktop on Windows or
# macOS) or a cluster later. The agents, git and terminals run inside the container; you open the
# web app from the machine's browser through a port mapped to its loopback.
#
#   docker compose -f docker/compose.yaml up --build
#
# See docs/DOCKER.md.

# The full image builds: it has the compilers node-pty needs. The slim one runs.
ARG BUILD_IMAGE=node:26.12.0-bookworm
ARG NODE_IMAGE=node:26.12.0-bookworm-slim

FROM ${BUILD_IMAGE} AS build
RUN npm install -g bun@1.4.4
WORKDIR /opt/gram
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter @gram/web build

FROM ${NODE_IMAGE}
# What threads use beside the agents: git for checkouts, ripgrep for search, ssh for remotes,
# lsof and procps for the port chips and busy terminals, tini to reap what the agents leave.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git lsof openssh-client procps ripgrep tini \
  && rm -rf /var/lib/apt/lists/*
# The GitHub CLI, for Clone from GitHub, pull requests and their checks: its release tarball for
# this architecture, checked against the release's checksums. An empty GH_VERSION leaves it out.
ARG GH_VERSION=2.80.0
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
# Owned by root: the agents run as gram and can't rewrite the server they run under.
COPY --from=build /opt/gram /opt/gram
USER gram
WORKDIR /home/gram
# All interfaces inside the container only (`GRAM_CONTAINER`); the port mapping decides who reaches
# it, and requests still need a loopback Host and the launch cookie.
ENV GRAM_CONTAINER=1 \
  GRAM_LISTEN_HOST=0.0.0.0 \
  GRAM_PORT=4317 \
  GRAM_WEB_ROOT=/opt/gram/apps/web/dist \
  GRAM_DATA_DIR=/home/gram/.gram-state \
  GRAM_FAKE_AGENT=0
EXPOSE 4317
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/gram/packages/server/src/main.ts"]
