# Gram in Docker

[Up: Development](DEVELOPMENT.md)

Gram's server and web app can run in a Linux container. On Windows, or on a Mac where you want the
agents to work on Linux, Docker Desktop then gives you a Linux machine to run them on. You use Gram
from your browser. The image is also the starting point for running Gram in a cluster later.

The image is built from source here. [Packages and images](PACKAGES.md) covers the published
images and the image of the worker host alone.

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

## Hosted features

The features for running Gram as a service behind another one are off unless **Hosted features**
is turned on, in Settings → About → Diagnostics. A server with no window takes the same setting
from its environment when it starts: `GRAM_EMBEDDING=1` turns it on, `GRAM_EMBEDDING=0` turns it
off, and without the variable the stored setting stays as it is. Only the app on the server's own
machine changes it; a paired phone can't.

### Move a workspace to another Gram

With hosted features on at both ends, a workspace can leave one Gram and carry on in another, for
example from the app on your computer to a server with no window. Both calls are for the app on
the server's own machine, with its launch cookie; a paired phone or a joined machine is refused.

1. On the Gram it leaves, `POST /workspaces/export` with `{"workspaceId": "…"}` answers the
   workspace as one JSON bundle. It is refused while the orchestrator is mid-turn, and it
   pauses the workspace there so two orchestrators never work the same branches. Send
   `"pause": false` to take a copy and keep it running.
2. On the Gram it moves to, `POST /workspaces/import` with
   `{"bundle": …, "projects": {"<project id in the bundle>": {"root": "/path/on/this/server"}}}`.
   Every repository of the workspace needs its folder here named; nothing is cloned or guessed.

What moves: the charter, stages and groups, the orchestrator's conversation and its memory, the
feature cards, the audit that budgets are counted from, and the transcript of every worker. The
orchestrator opens under the same thread on a new session, on a model this server chooses, and its
first digest tells it what moved and where its repositories are now.

What stays: agent sessions, worktrees and anything not pushed from them, folder grants, approvals
in flight, file checkpoints, attachments, routines' state and sign-ins. Workers that were open
arrive as finished ones: their branch, pull requests and last report are told to the orchestrator,
which starts workers again where it needs them. Push the branches before you export.

An import replaces nothing. It is refused when the workspace or its orchestrator's thread is
already there, when the bundle came from a newer Gram, or when a repository has no usable folder.
The app's settings in the bundle (review bots and workspace defaults) are taken only with
`"adoptSettings": true`. A bundle is scrubbed of what looks like a credential, but it holds your
conversation and memory: keep it as you would those. Import only a bundle you exported or trust: it
brings its own charter, with its autonomy, and its orchestrator starts working. Its routines arrive
switched off, for you to turn on here.

| Build argument        | Default                       | What it sets                                  |
| --------------------- | ----------------------------- | --------------------------------------------- |
| `CLAUDE_CODE_VERSION` | the version in the Dockerfile | Claude Code from npm                          |
| `CODEX_VERSION`       | unset                         | Codex from npm, when set                      |
| `GH_VERSION`          | `2.103.3`                     | The GitHub CLI's release; empty leaves it out |
| `NODE_IMAGE`          | `node:26.13.0-bookworm-slim`  | The image it runs on                          |
| `BUILD_IMAGE`         | `node:26.13.0-bookworm`       | The image it builds in                        |

## A headless control plane

With `GRAM_HEADLESS=1` the server runs no work itself. It starts no agent, opens no terminal and
makes no worktree in the container; every thread, an orchestrator's included, runs on a
[joined machine](MACHINES.md). It is one of the hosted features, so the server only starts with
`GRAM_EMBEDDING=1` set as well (or the setting already stored on), and says so when it isn't.

```yaml
services:
  gram:
    environment:
      GRAM_EMBEDDING: "1"
      GRAM_HEADLESS: "1"
```

- A thread whose request names no machine goes on the confirmed machine online now that joined
  first. A worker's `machine` and the composer's Machine select still pick another.
- An orchestrator works in the machine's own clone of its project, on the clone's default branch.
  Workers get worktrees of that clone, as they do on any joined machine.
- With no machine joined, or none online, starting a thread is refused with the reason. Opening a
  terminal here, or a thread in a worktree of this machine, is always refused.
- The models offered are the ones the default machine's Claude Code lists. The launch checks for
  local tools don't run.
- Not on a machine yet, so not available headless: Codex sessions, sessions through a gateway
  profile, memory updates, and handing an orchestrator over to a new session.
- The server still keeps a folder for each project (added or cloned in the container), which it
  reads the project's remote and branches from. Nothing is run in it.
