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

What a deployment configures once it is on is in [running Gram behind another service](EMBEDDING.md).

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

### Sign-in through a proxy

With hosted features on, a server can leave sign-in to a proxy you run in front of it: an
identity-aware proxy or a gateway of your own. The proxy signs people in however it likes, then
tells Gram who each request is from in a statement it signs. The launch token no longer signs
anyone in, and isn't printed.

Set all four of these where the server runs. With some of them missing or malformed the server
refuses to start.

| Variable                 | What it sets                                                                      |
| ------------------------ | --------------------------------------------------------------------------------- |
| `GRAM_IDENTITY_KEYS`     | The proxy's Ed25519 public keys, as a JWK Set (`{"keys":[…]}`), each with a `kid` |
| `GRAM_IDENTITY_ISSUER`   | The `iss` the proxy's statements carry                                            |
| `GRAM_IDENTITY_AUDIENCE` | The `aud` that names this one server; a statement for another is refused          |
| `GRAM_PUBLIC_ORIGIN`     | The one `https://` origin browsers use; a request from another origin is refused  |

On every request, WebSocket upgrades included, the proxy sets the `x-gram-identity` header to a
JWT signed with one of those keys (`alg` `EdDSA`), and removes any `x-gram-identity` the client
sent. The claims:

- `iss` and `aud`, as configured.
- `sub`, an id for the person that never changes, and optionally `name` to show.
- `role`: `member`, who can do everything, or `viewer`, who can read threads, diffs, docs,
  memory and settings, and change nothing. A viewer can read any file in a thread's folders,
  including ones that hold secrets, such as `.env`.
- `iat` and `exp`, at most five minutes apart. Make a new statement per request.

What sits in front can also speak for itself. A statement whose header has `typ`
`gram-service+jwt`, with `role` `service` and a `path` claim, names no person: it is the
platform's own, for the calls only it makes. It reaches `POST /machines/provision`,
`/machines/remove` and `/machines/list`, to register and remove the hosts it starts,
`POST /machines/stop/status`, `/prepare`, `/cancel` and `/resume`, to stop and resume them, and
`POST /workspaces/export` and `/workspaces/import`, to move a workspace in or out. It reaches
nothing else, and a member or a viewer reaches none of those.

- `path` is the one path the statement is for, such as `/machines/provision`. Sign one per call.
- Send `Origin` set to the public origin, as the app's own requests carry.
- It removes only hosts registered this way, never a machine someone joined.
- Never sign one for someone who signed in: whoever holds one can add a machine that threads
  then run on. The `typ` header is what marks it, so a role copied from your directory can't.
- Its calls are recorded like a member's, under its `sub`, with how each was answered.

The server holds public keys only, so it can't sign a statement itself. What you have to keep
true around it:

- The proxy is the only thing that can reach the server's port. A statement is good for a few
  minutes for whoever holds it, so the hop from the proxy to the server stays private.
- A WebSocket is checked when it opens and keeps its person and role until it closes. When
  someone signs out or their role changes, the proxy closes their connections.
- A WebSocket the proxy leaves open is closed by the server after 15 minutes, and the app
  connects again with a new statement.
- The proxy doesn't route `/mcp` or `/host/*`. Those are the agents' and joined machines' own
  routes, with each thread's token or a machine's own proof, and are unchanged. A request there
  that carries a statement is refused. Phone access and the Machines page are off behind a proxy.
- With the four variables set but hosted features off, the server logs a warning and takes the
  launch token as usual.

Each change a member makes is recorded with who made it: the call, the thread or workspace, and
what identifies the thing changed (a message's id, a request and its allow or deny, the names of
the settings), never what was typed. A call that failed is recorded as failed. Keystrokes in a
terminal aren't recorded; opening one is. The `actor_events` table in the database holds a year
of them. A message, an answer and a settings change by two people are two people's entries.

### Decision hook

With hosted features on and `GRAM_DECISION_HOOK_URL` set (an `http` or `https` URL with no
credentials in it; `GRAM_DECISION_HOOK_TOKEN` is sent as a bearer token, or the contents of the file `GRAM_DECISION_HOOK_TOKEN_FILE` names, read again for every call, for a token that is replaced while the server runs), the server asks that
endpoint before an outward action and does what it answers: `allow`, `refuse`, or `ask` a person.
The [wire shapes](../packages/contracts/src/embedding.ts) are version 1.

| Asked about                                                       | Where                                                                                                                                         |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A push, and opening, merging or closing a pull request, a release | An agent's own shell command, read as the [outward gate](../packages/agents/src/outward.ts) reads it; the app's Push and pull request buttons |
| A connector's call                                                | A Claude agent's call to any MCP server but Gram's own                                                                                        |
| A spawn, and arming a merge                                       | The orchestrator's `spawn_worker` and `merge_when_ready`, and a thread's `set_auto_merge`                                                     |

- `allow` on an agent's command answers it with no card. On one of Gram's own tools it leaves the
  call to the approval Gram would have asked for anyway.
- `refuse` stops the action. The agent is told why in the call's result, and the thread shows the
  same line as a notice.
- `ask` raises the usual approval card, with the endpoint's reason on it. When a person approves
  it the endpoint is asked again, naming the first call and the card, and the action runs only if
  that answer is `allow`.
- With sign-in through a fronting proxy on, a request for something a person did in the app
  carries that person's id as `actor.id`, and the second call for an approved card names who
  approved it in `approval.answeredBy`.
- No answer within ten seconds, any status but 200, or an answer that doesn't read as one is a
  refusal. Redirects aren't followed, and an answer over 64 KiB isn't read.
- A `GRAM_DECISION_HOOK_URL` that is set but isn't a whole `http(s)` URL (or has credentials or a
  fragment in it), or a token with spaces or control characters, refuses every one of these
  actions and says so in the log at start. It does not turn the hook off.

While it is on, every thread's sessions open with the outward gate at its strictest and their
connector calls gated, whatever the workspace's autonomy says, so that each of those calls reaches
the endpoint; turning it on or off takes effect in sessions opened afterwards. Like the outward
gate, it reads command spellings: it is not a boundary against an agent that pushes by a route
Gram can't see, which is for whatever holds the credentials to enforce. Not asked yet: a Codex
agent's connector calls, a routine's own spawn, and the merge an armed `merge_when_ready` makes
later (it is asked when the merge is armed). A session that was already open when the hook came
on keeps the gates it opened with until it is next opened.

### Event sink

With hosted features on and `GRAM_EVENT_SINK_URL` set (`GRAM_EVENT_SINK_TOKEN` as its bearer
token, or `GRAM_EVENT_SINK_TOKEN_FILE` as for the hook), the server sends what happens to that endpoint in order: threads as they are made, change
and go, each thread's status, approval cards and questions as they open and close, feature cards,
each turn's usage, and every decision the hook made.

- Events are numbered from 1 with no gaps and kept in `event-sink.db` in the data folder until
  the receiver confirms them. Each POST carries the next few; the answer `{"ack": n}` says the
  highest number the receiver holds, and the next POST starts at `n + 1`, forward or back.
- Delivery is at least once: a receiver ignores a number it already holds. After a restart the
  server goes on from the last confirmed number, so nothing recorded is skipped.
- Each start opens with `sink.started`, which lists every open thread, for a receiver to put
  right what a crash kept from being recorded.
  It also lists the cards open now (`openAsks`): any other card a receiver holds open was
  withdrawn. A server drops its cards when it restarts, so the list is then empty.
- With sign-in through a fronting proxy, a thread's events say who started it (`createdBy`).
  Each usage reading names its turn (`turnId`); readings are running totals for that turn.
- The last 10,000 confirmed events are kept in case the receiver falls back. If it asks for older
  ones, or the file is lost, a new `source` id starts again at 1. An `ack` above the last number
  in the POST it answers is not believed, and the same events are sent again.
- If the receiver takes nothing while 200,000 events wait, the backlog is given up and a new
  `source` id starts at 1 with `sink.started`.
- A card's closing says how: `answered`, with the person's `approve` or `reject` and (with
  sign-in through a fronting proxy) who they are, or `withdrawn` when it went unanswered.
- Nothing is recorded while hosted features are off. Transcript messages aren't sent yet.

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

- A machine gets in as any does: joined over Tailscale, or, with no tailnet around the
  container, registered by its key as a [provisioned host](PROVISIONED_HOSTS.md).
- A thread whose request names no machine goes on the confirmed machine online now that joined
  first. A worker's `machine` and the composer's Machine select still pick another.
- An orchestrator works in the machine's own clone of its project, on the clone's default branch.
  Workers get worktrees of that clone, as they do on any joined machine.
- With no machine joined, or none online, starting a thread is refused with the reason. Opening a
  terminal here, or a thread in a worktree of this machine, is always refused.
- A thread started from a [profile](THREAD_PROFILES.md#on-a-headless-control-plane) goes on the
  same machine, in a folder its host makes for it.
- The models offered are the ones the default machine's Claude Code lists. The launch checks for
  local tools don't run.
- Not on a machine yet, so not available headless: Codex sessions, sessions through a gateway
  profile, memory updates, and handing an orchestrator over to a new session.
- The server still keeps a folder for each project (added or cloned in the container), which it
  reads the project's remote and branches from. Nothing is run in it.
