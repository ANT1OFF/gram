# Running Gram behind another service

[Up: Docker](DOCKER.md#hosted-features)

A Gram server can run as one part of a larger deployment: self-hosted for a team, or inside a
platform that brings its own sign-in, scheduling and storage. This page covers the seams such a
deployment configures. Every one of them is inert until **Hosted features** is on
([Docker](DOCKER.md#hosted-features)); with it off the server behaves as the desktop app's own,
whatever its environment says.

The seams are configured from the server's environment, never from settings, and a malformed
value stops the server at start rather than half-configuring it.

| Variable           | What it sets                                                                   |
| ------------------ | ------------------------------------------------------------------------------ |
| `GRAM_EMBED_TOKEN` | The bearer token the platform's services send on `/embed/v1/*`                 |
| `GRAM_REPO_EVENTS` | `pushed`: repository events arrive on `/embed/v1/repo-events`; needs the token |

Tokens are at least 32 characters with no whitespace.

## Calls into the server

The platform's own services call the server under `/embed/v1/`. These paths exist only while
Hosted features is on and `GRAM_EMBED_TOKEN` is set; otherwise a request to one is answered as a
request to any path the server doesn't have.

A caller proves itself with `Authorization: Bearer <GRAM_EMBED_TOKEN>` and nothing else. No cookie
stands in for the token, a request carrying an `Origin` header is refused whatever its token, and
the token opens no other path. These calls are let past the loopback `Host` check, since a service
reaches the server by its address inside the deployment: keep the server's port off any network a
browser or an untrusted workload can reach. Bodies are JSON objects of at most 256 KB.

| Status | Meaning                                                  |
| ------ | -------------------------------------------------------- |
| `200`  | Done; the body says what was done                        |
| `400`  | The body isn't what the path takes; `error` says what is |
| `401`  | No bearer token, or not the configured one               |
| `403`  | The request carried an `Origin`                          |
| `404`  | No such path under `/embed/v1/`                          |
| `405`  | The path doesn't take that method                        |
| `413`  | The body is over 256 KB                                  |

## Pushed repository events

By default the server asks GitHub about each open thread's pull request on a timer. With
`GRAM_REPO_EVENTS=pushed` it stops: whoever receives the repository's webhooks tells the server
what changed, and the server reads that pull request then.

```http
POST /embed/v1/repo-events
Authorization: Bearer <GRAM_EMBED_TOKEN>
Content-Type: application/json

{ "events": [ { "repo": "acme/web", "number": 12, "branch": "feat/x", "kind": "check" } ] }
```

- `repo` is `owner/name`. `number` is the pull request and `branch` its head branch; both are
  optional. Send `branch` for a pull request that was just opened, which its checkout knows only by
  its branch. An event naming neither is about every checkout of the repository.
- `kind` is one of `pull_request`, `check`, `review` and `comment`. It is optional and only logged.
- A call carries 1 to 200 events and answers `{ "accepted": <events>, "checkouts": <read> }`.

An event carries no state. It names what changed and the server reads it from GitHub as it reads
everything else, so a stale or mistaken event costs one read and shows nothing untrue. Events for
one checkout within a second are one read. An event touches a checkout when it names the pull
request the checkout shows, its branch, or a pull request one of its threads is bound to, follows
or has a wake on.

What changes while events are pushed:

- The background sweeps leave GitHub alone, apart from one read per checkout every 20 minutes as
  the fallback for an event that never arrived.
- A person opening a thread, and any action that needs a fresh answer (a merge, a rerun), still
  read at once.
- Watched workflow runs (`run_monitor`), review requests and event routines keep their own timers.
