# Gram in Docker

[Up: Development](DEVELOPMENT.md)

Gram's server and web app can run in a Linux container. On Windows, or on a Mac where you want the
agents to work on Linux, Docker Desktop then gives you a Linux machine to run them on. You use Gram
from your browser. The image is also the starting point for running Gram in a cluster later.

The image is built from source; no published image exists yet.

## Run it

```sh
docker compose -f docker/compose.yaml up --build -d
docker compose -f docker/compose.yaml logs --no-log-prefix gram | grep '^boot ' | tail -1
```

Open the `boot http://127.0.0.1:4317/?boot=…` address the server printed. It signs this browser in.
The address holds the launch token: anyone who has it can use this Gram, so don't paste it into a
chat or a ticket. A restart prints a new one.

The compose file maps the port to this machine's loopback only (`127.0.0.1:4317`), on the same
port the server listens on inside the container, so the printed address works as it is. Other
machines on your network can't reach it.

## Sign the agents in

The agents run inside the container and keep their logins in its home folder, which is a volume,
so a login lasts across restarts and rebuilds.

```sh
docker compose -f docker/compose.yaml exec gram claude
```

Run `/login` there and follow the link. Then choose **Check again** in Gram. Codex is in the image
only when it was built with `--build-arg CODEX_VERSION=<version>`. Its browser login returns to a
port inside the container, so use its device code instead:
`docker compose -f docker/compose.yaml exec gram codex login --device-auth`.

The GitHub CLI is in the image (`--build-arg GH_VERSION=` leaves it out); **Clone from GitHub**,
pull requests and their checks need it. Sign in with
`docker compose -f docker/compose.yaml exec gram gh auth login` and choose the one-time code.

## Your code

Clone repositories inside the container, from **Clone from GitHub** in Gram or with `git clone` in
`docker compose -f docker/compose.yaml exec gram bash`. They live in the `gram-home` volume with
everything else Gram keeps. A folder bind-mounted from Windows works too, but git and file watching
are much slower across that boundary.

## What it changes

- The image sets `GRAM_CONTAINER=1` and `GRAM_LISTEN_HOST=0.0.0.0`, so the server listens on the
  container's own network, which only the port mapping reaches. Without `GRAM_CONTAINER=1` the
  server ignores `GRAM_LISTEN_HOST` and listens on loopback, and the desktop app drops both. Every
  request still needs a loopback `Host` and the launch cookie.
- To use another port, change the mapping's two sides and `GRAM_PORT` together. A `Host` that
  doesn't match the server's port is refused.
- Phone access, the desktop app's tray and native notifications aren't part of the container.
- Sign-ins that return to `localhost`, such as connectors' and Codex's browser login, can't reach
  the container. Previews of an agent's dev server run on the container's loopback and don't open
  from your browser yet.

| Build argument        | Default                       | What it sets                                  |
| --------------------- | ----------------------------- | --------------------------------------------- |
| `CLAUDE_CODE_VERSION` | the version in the Dockerfile | Claude Code from npm                          |
| `CODEX_VERSION`       | unset                         | Codex from npm, when set                      |
| `GH_VERSION`          | `2.103.3`                     | The GitHub CLI's release; empty leaves it out |
| `NODE_IMAGE`          | `node:26.13.0-bookworm-slim`  | The image it runs on                          |
| `BUILD_IMAGE`         | `node:26.13.0-bookworm`       | The image it builds in                        |
