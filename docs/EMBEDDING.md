# Running Gram behind another service

[Up: Docker](DOCKER.md#hosted-features)

A Gram server can run as one part of a larger deployment: self-hosted for a team, or inside a
platform that brings its own sign-in, scheduling and storage. This page covers the seams such a
deployment configures. Every one of them is inert until **Hosted features** is on
([Docker](DOCKER.md#hosted-features)); with it off the server behaves as the desktop app's own,
whatever its environment says.

The seams are configured from the server's environment, never from settings, and a malformed
value stops the server at start rather than half-configuring it.

| Variable                   | What it sets                                                                   |
| -------------------------- | ------------------------------------------------------------------------------ |
| `GRAM_EMBED_TOKEN`         | The bearer token the platform's services send on `/embed/v1/*`                 |
| `GRAM_REPO_EVENTS`         | `pushed`: repository events arrive on `/embed/v1/repo-events`; needs the token |
| `GRAM_SCHEDULER_URL`       | Where wakes, snoozes and routine runs are registered; needs the token          |
| `GRAM_SCHEDULER_TOKEN`     | The bearer token sent to the scheduler                                         |
| `GRAM_OBJECT_STORE_URL`    | Where attachments, docs and outputs are kept as well as on the disk            |
| `GRAM_OBJECT_STORE_TOKEN`  | The bearer token sent to the object store                                      |
| `GRAM_HOST_PROVIDER_URL`   | Where a person's machine is asked for, on a headless server; needs the token   |
| `GRAM_HOST_PROVIDER_TOKEN` | The bearer token sent to the host provider                                     |

Tokens are at least 32 characters with no whitespace. The server takes them out of its own
environment once it has read them, so no agent, terminal or `git` process it starts inherits one.

## Calls into the server

The platform's own services call the server under `/embed/v1/`. These paths exist only while
Hosted features is on and `GRAM_EMBED_TOKEN` is set; otherwise a request to one is answered as a
request to any path the server doesn't have.

A caller proves itself with `Authorization: Bearer <GRAM_EMBED_TOKEN>` and nothing else. No cookie
stands in for the token, a request carrying an `Origin` header is refused whatever its token, and
the token opens no other path. These calls are let past the loopback `Host` check, since a service
reaches the server by its address inside the deployment: keep the server's port off any network a
browser or an untrusted workload can reach. Bodies are JSON objects of at most 256 KB.

With [sign-in through a proxy](DOCKER.md#sign-in-through-a-proxy) on, these calls still take the
token alone and need no signed statement. A request that carries a statement is a person's, and a
person has no path under `/embed/v1/`: the proxy doesn't route them.

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
- `kind` is one of `pull_request`, `check`, `review` and `comment`. It is optional and changes
  nothing: the read shows whatever changed.
- A call carries 1 to 200 events and answers `{ "accepted": <events>, "checkouts": <read> }`.

An event carries no state. It names what changed and the server reads it from GitHub as it reads
everything else, so a stale or mistaken event costs one read and shows nothing untrue. Events for
one checkout within a second are one read, reads of one checkout are at least five seconds apart,
and no read is made while GitHub is rate limiting the server. Without `GRAM_REPO_EVENTS=pushed`
the path answers `409`. An event touches a checkout when it names the pull
request the checkout shows, its branch, or a pull request one of its threads is bound to, follows
or has a wake on.

What changes while events are pushed:

- The background sweeps leave GitHub alone, apart from one read per checkout every 20 minutes as
  the fallback for an event that never arrived.
- A person opening a thread, and any action that needs a fresh answer (a merge, a rerun), still
  read at once.
- Watched workflow runs (`run_monitor`), review requests and event routines keep their own timers.

## An outside scheduler

A wake an agent set, a snooze and a routine's next run each wait for a time. The server waits in
its own process, which is enough while it runs. A server that is stopped while idle fires nothing,
so with `GRAM_SCHEDULER_URL` set each wait is also registered with the deployment's scheduler,
which starts the server if it has to and calls back when the time comes.

The server tells the scheduler a key and a time, and nothing of what the wait is for:

```http
PUT <GRAM_SCHEDULER_URL>/timers/<key>
Authorization: Bearer <GRAM_SCHEDULER_TOKEN>

{ "key": "wake:6f0c…", "at": "2026-01-01T09:00:00.000Z", "atMs": 1767258000000 }
```

```http
DELETE <GRAM_SCHEDULER_URL>/timers/<key>
```

`PUT` replaces whatever the key held, and `DELETE` of a key the scheduler doesn't hold may answer
`404`. Keys are `wake:<id>`, `workspace-wake:<id>`, `snooze:<thread>` and
`routine:<workspace>:<routine>`, percent-encoded in the path. Redirects are not followed.

When a timer's time comes, the scheduler calls the server:

```http
POST /embed/v1/timers/fire
Authorization: Bearer <GRAM_EMBED_TOKEN>

{ "key": "wake:6f0c…" }
```

The answer is `{ "fired": true }`, or `{ "fired": false }` when nothing waits on that key: the wait
was cancelled or has fired already, and the scheduler drops it. `GET /embed/v1/timers` lists what
is waiting now, as `{ "timers": [{ "key", "at", "atMs" }] }`, for a scheduler that wants to check
its copy.

What to rely on:

- **The server's store stays the record.** What is due, and for whom, is decided by the server from
  its own database. A call for a time that hasn't come by the server's clock is waited out, not
  obeyed, so a scheduler can't fire a wake early.
- **A restart re-registers.** A server that starts arms every stored wait again: whatever fell due
  while it was down fires at once, and the rest are registered again with `PUT`. Start the server
  before calling `fire`, or call again when it answers.
- **A scheduler that is down delays, and loses nothing.** A registration that fails is retried
  every 30 seconds while the server runs, and a wait whose call never comes ends by itself
  30 seconds after its time.
- A routine that watches for events registers each of its looks, a few minutes apart, so such a
  routine keeps waking a server that would otherwise idle.

## An object store

With `GRAM_OBJECT_STORE_URL` set, attachments, docs and the files threads produce are kept in the deployment's object store as well as on the server's disk, so they outlive that disk and it can stay small. The data folder stays what the server reads and writes; the store is its mirror.

- An attachment is sent as it is uploaded. Every minute the attachments and docs folders are walked, and whatever is new or changed since it was last sent is sent: a doc that was saved, an image a tool call returned, a fork's copies.
- A file a thread produced in its checkout (a report, a screenshot it wrote) is copied to the store when it is recorded as an output, since a checkout doesn't outlive its thread.
- A closed thread's attachments and outputs are deleted from the store with it. Nothing else is deleted: a file missing on the disk is never taken as a reason to delete it in the store.
- A server that starts on a fresh disk lists the docs in the store and brings them back before anything reads them. An attachment is brought back the first time the transcript shows it.

The store is plain HTTP, and every call carries `Authorization: Bearer <GRAM_OBJECT_STORE_TOKEN>` when the token is set. A redirect is refused.

| Call                              | Meaning                                                |
| --------------------------------- | ------------------------------------------------------ |
| `PUT <url>/objects/<key>`         | Keep these bytes under the key, replacing what it held |
| `GET <url>/objects/<key>`         | The bytes, or `404`                                    |
| `GET <url>/objects?prefix=<p>`    | `{ "keys": ["<key>", …] }`: every key under the prefix |
| `DELETE <url>/objects?prefix=<p>` | Delete every key under the prefix; `404` is fine       |

| Key                                                   | What it is                                           |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `attachments/<threadId>/<file>`                       | A thread's attachment or stored tool image           |
| `docs/<workspaceId>/<docId>.doc`                      | A doc's record: its metadata line, then its Markdown |
| `outputs/<threadId>/<16 hex of SHA-256(path)>/<name>` | A file the thread produced outside its attachments   |

Limits:

- A file over 64 MB is neither sent nor brought back.
- What was sent is remembered in `object-store.json` in the data folder. Without it (a fresh disk) everything on the disk is sent again, once.
- An output on another machine's checkout is not copied: the server copies only files it can read itself.
- An output copied to the store is not read back from it by the Files view; the deployment serves it from the store by its key.
- A send that fails is tried again at the next walk, and an output's at the next time it is recorded.
- A delete the store didn't confirm is kept in `object-store.json` and asked again at each walk.
- A file is sent only from where it was when it was checked: one whose folder has since become a link is left out, and the log says so.

## Hosts on demand

A headless server runs no work itself: a thread needs a machine. With `GRAM_HOST_PROVIDER_URL` set,
the deployment can start one for the person who asks, and the server places that person's work on
it and nobody else's.

**A person asks.** A person signed in through the proxy sends a plain HTTP request, which the proxy
signs and can bind to that one request (its method, path and the hash of its body):

```http
POST /machines/on-demand/start
{ "repositories": ["acme/web", "acme/api"] }
```

A viewer is refused. A person whose machine is online is told so, and nothing is asked. Otherwise
the server asks the provider, passing the proxy's statement on exactly as received, as the
provider's proof that this person asked:

```http
POST <GRAM_HOST_PROVIDER_URL>/hosts/start
Authorization: Bearer <GRAM_HOST_PROVIDER_TOKEN>

{ "kind": "personal", "owner": "<person>", "options": { "repositories": [...] },
  "proof": { "statement": "…", "method": "POST", "path": "/machines/on-demand/start", "body": "…" } }
→ { "hostKey": "<the provider's name for this host>" }
```

`POST /machines/on-demand/stop` asks `<url>/hosts/stop` the same way, and
`GET /machines/on-demand/status` answers the person with their own machine and the start's progress.
Nothing else starts one: an agent, a skill or a repository's instructions have no path to these.

**The provider registers the host** as any provisioned host ([Provisioned hosts](PROVISIONED_HOSTS.md)),
naming the person in `owner` and `onDemand: "personal"`. From then on:

- a thread that person starts with no machine named goes on their own machine while it is online;
- a host started for one person is never anyone's default, and work that names it for anyone else
  is refused;
- every other way onto it is that person's alone too: a terminal there (its Sign in shell
  included), keystrokes into one, a session, a file or git read, a fork in a thread's checkout
  there, and any change to a thread on it (a send, a restart, a close). Another member still reads
  what the workspace shows of such a thread; a call with no signed-in person reaches none of it;
- an agent's tool call is made for the person its thread's lineage is for: the owner of the host
  the thread is on, else its spawner's, up the chain. It is never read from the call's input, nor
  taken from whoever's request began the turn. So an orchestrator on a person's host spawns its
  workers there, and a thread on no one's host can't place work on anyone's;
- a thread is the person's whose host it works on, or whose lineage it is under: a worker on a
  shared machine under that person's orchestrator is theirs too. Only they change it, by any
  route: a send or steer, an answer to its card or question (`POST /asks/answer` included), a
  task for its workspace (named by the workspace or by one of its projects), a charter or pause
  of that workspace, or a join. Joining hands a thread its orchestrator's lineage, so whoever
  asks must be both the thread's owner and the orchestrator's, even for a thread on no one's
  machine. The check is made where these reach the agent, so no other route gets past it. That
  includes a notice, an interrupt or a system delivery made in someone's call. The server's own
  notices, with no caller, are not refused;
- what acts on a workspace's workers is checked against each worker it reaches, not only the
  orchestrator: an answer to or dismissal of a worker's question, before it is written, and a
  feature's pause, archive, rename, stage or group, before anything changes. A worker on a
  person's machine is theirs even under an orchestrator on no one's;
- work kept to be done later records who it was for. An owed answer to a worker's question is
  delivered as the person who gave it (`closedFor`), a retry after a restart included. If they
  may no longer change the worker, it is settled undelivered and never sent as the server's own;
- a thread moved onto another machine keeps its owner: the machine it goes to was started for
  the same person as the one it is on, or neither was for anyone (`keepsOwner`);
- a person with no machine of their own is told to start one, where before they were told to join
  one.

**The provider reports progress** while it starts the host, on `POST /embed/v1/hosts/progress`
with `{ owner, hostKey, phase, step?, message? }`. `phase` is one of `starting`, `booting`,
`joining`, `ready`, `stopping`, `stopped` or `failed`. Only a host key the server asked for, for that
owner, is taken: anything else is `404`. Progress is kept in memory, for the person's status.

## Settings supplied from outside

The deployment can set some of the settings for this server. A supplied setting reads as supplied to everything inside, and nothing inside can change it: the Settings page, a paired phone and an agent's `settings_propose` are each refused, with a message that says the service that runs this Gram set it.

```
PUT /embed/v1/settings
{ "settings": { "logLevel": "info", "updates": { "channel": "stable" } } }
→ { "supplied": ["logLevel", "updates.channel"] }

GET /embed/v1/settings
→ { "settings": { "logLevel": "info", "updates": { "channel": "stable" } } }
```

- The body is a settings patch, the shape the app's own saves have: a section's fields, or a top-level key. `null` for an optional field keeps it cleared.
- Each `PUT` replaces everything supplied before. `{ "settings": {} }` supplies nothing, and `GET` then answers `null`.
- The answer lists what was taken. A setting this build doesn't know is left out of it rather than refused, so a deployment can tell which of its settings are in force.
- What is supplied is kept in the server's database and holds through a restart. It is applied only while the hosted features are on.
- A setting that is no longer supplied keeps the value it last had, and can be changed inside again.
- `experimental.embedding` can't be supplied: it is what turns this on (`GRAM_EMBEDDING`).
- Every other setting can be supplied, the default permission mode, the terminal's shell and the editor command among them. Whoever holds `GRAM_EMBED_TOKEN` configures this server as its owner would, and the person using it can't undo that: give the token only to the service that is meant to.

The Settings page doesn't yet mark a supplied setting: a change to one fails with the message above.
