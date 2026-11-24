# Running Gram behind another service

[Up: Docker](DOCKER.md#hosted-features)

A Gram server can run as one part of a larger deployment: self-hosted for a team, or inside a
platform that brings its own sign-in, scheduling and storage. This page covers the seams such a
deployment configures. Every one of them is inert until **Hosted features** is on
([Docker](DOCKER.md#hosted-features)); with it off the server behaves as the desktop app's own,
whatever its environment says.

The seams are configured from the server's environment, never from settings, and a malformed
value stops the server at start rather than half-configuring it.

| Variable                   | What it sets                                                                      |
| -------------------------- | --------------------------------------------------------------------------------- |
| `GRAM_EMBED_TOKEN`         | The bearer token the platform's services send on `/embed/v1/*`                    |
| `GRAM_REPO_EVENTS`         | `pushed`: repository events arrive on `/embed/v1/repo-events`; needs the token    |
| `GRAM_SCHEDULER_URL`       | Where wakes, snoozes and routine runs are registered; needs the token             |
| `GRAM_SCHEDULER_TOKEN`     | The bearer token sent to the scheduler (or `GRAM_SCHEDULER_TOKEN_FILE`)           |
| `GRAM_OBJECT_STORE_URL`    | Where attachments, docs and outputs are kept as well as on the disk               |
| `GRAM_OBJECT_STORE_TOKEN`  | The bearer token sent to the object store (or `GRAM_OBJECT_STORE_TOKEN_FILE`)     |
| `GRAM_HOST_PROVIDER_URL`   | Where a person's machine is asked for, on a headless server; needs the token      |
| `GRAM_HOST_PROVIDER_TOKEN` | The bearer token sent to the host provider (or `GRAM_HOST_PROVIDER_TOKEN_FILE`)   |
| `GRAM_GITHUB_ROUTE_URL`    | Where a headless server's `gh` reaches GitHub ([A GitHub route](#a-github-route)) |
| `GRAM_GITHUB_ROUTE_TOKEN`  | The bearer token sent to the GitHub route (or `GRAM_GITHUB_ROUTE_TOKEN_FILE`)     |
| `GRAM_SECRET_PATHS`        | More places holding the deployment's secrets, which no file preview reads         |

Tokens are at least 32 characters with no whitespace. A `*_TOKEN_FILE` is an absolute path in
place of its token, never beside it, and is read again for every call, so a deployment can hand
the server short-lived workload tokens that it rotates on disk. The server takes them out of its own
environment once it has read them, so no agent, terminal or `git` process it starts inherits one.
A file a `*_TOKEN_FILE`, `*_SECRET_FILE` or provisioned TLS setting names, and the folder holding
it, are never read by a file preview or a file link, whatever a thread's messages say; so is every
path in `GRAM_SECRET_PATHS` (absolute, separated by the platform's path delimiter). On a server
people sign in to, a preview reads only inside a thread's own folders.

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
- A thread on another machine: the file is checked and read on that machine, a part at a time through its host, and copied to the store under the same key, so it outlives the machine. Its path in the key is the path on that machine. This needs a host that names the `file-parts` feature; with an older host the file is neither recorded nor copied, as before.
- A closed thread's attachments and outputs are deleted from the store with it, and so is anything the deployment keeps under `sessions/<threadId>/`. Nothing else is deleted: a file missing on the disk is never taken as a reason to delete it in the store.
- A server that starts on a fresh disk lists the docs in the store and brings them back before anything reads them. An attachment is brought back the first time the transcript shows it.

The store is plain HTTP, and every call carries `Authorization: Bearer <GRAM_OBJECT_STORE_TOKEN>` when the token is set. A redirect is refused.

| Call                              | Meaning                                                |
| --------------------------------- | ------------------------------------------------------ |
| `PUT <url>/objects/<key>`         | Keep these bytes under the key, replacing what it held |
| `GET <url>/objects/<key>`         | The bytes, or `404`                                    |
| `GET <url>/objects?prefix=<p>`    | `{ "keys": ["<key>", …] }`: every key under the prefix |
| `DELETE <url>/objects?prefix=<p>` | Delete every key under the prefix; `404` is fine       |

| Key                                                   | What it is                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `attachments/<threadId>/<file>`                       | A thread's attachment or stored tool image                                                                                                  |
| `docs/<workspaceId>/<docId>.doc`                      | A doc's record: its metadata line, then its Markdown                                                                                        |
| `outputs/<threadId>/<16 hex of SHA-256(path)>/<name>` | A file the thread produced outside its attachments                                                                                          |
| `sessions/<threadId>/…`                               | The deployment's own: a thread's agent sessions it keeps so they outlive a machine. Gram never writes there, and deletes it with the thread |

Limits:

- A file over 64 MB is neither sent nor brought back.
- What was sent is remembered in `object-store.json` in the data folder. Without it (a fresh disk) everything on the disk is sent again, once.
- An output on another machine is copied only while that machine is connected and its host names `file-parts`. It is read into `object-store-staging` in the data folder, sent from there and removed; that folder is emptied at each start.
- An output copied to the store is not read back from it by the Files view; the deployment serves it from the store by its key.
- A send that fails is tried again at the next walk, and an output's at the next time it is recorded.
- A delete the store didn't confirm is kept in `object-store.json` and asked again at each walk.
- A file is sent only from where it was when it was checked: one whose folder has since become a link is left out, and the log says so.

## A GitHub route

A headless server (`GRAM_HEADLESS=1`) keeps the network tier: PR badges and checks, the CI monitor, merges and auto-merge, review bots and the default-branch watch all run `gh` on it. A deployment that gives the server no GitHub credential of its own sets `GRAM_GITHUB_ROUTE_URL`, and every `gh` the server runs reaches GitHub through that route instead.

- The server serves a socket at `github-relay/gh.sock` in its data folder and points `gh` at it (`GH_CONFIG_DIR`, with `http_unix_socket`). `gh` is given a placeholder `GH_TOKEN`, which is never sent on.
- Each request goes to `<url>/api<path>`, `<url>/uploads<path>` or `<url>/codeload<path>`, by the host `gh` asked for, with `Authorization: Bearer <token>` (the token file, when one is named, is read on every call) and `x-gram-upstream-host`. A redirect is handed back to `gh` as it came.
- A call made for one thread (`merge_when_ready`'s merge, `set_auto_merge`) carries `x-gram-thread: <threadId>`, so the route can act for that thread's person and check what it may do. Every call names one: the relay answers a call that names none with a `403` of its own and sends nothing on.
- The route answers as GitHub would: `gh` reads the answer as GitHub's.
- Adding a repository (`projects.clone`) is made for no thread, so it asks GitHub nothing: the origin is filed, and the route answers for the repository when the first thread's machine clones it.

The route is refused on a server that runs work itself, which would hand its agents the same `gh`, and a route that is given and can't be used stops the server at start.

## Shared folders

Each workspace's shared folder (`docs/AGENTS_AND_FEATURES.md`, "Workspace shared folder") is kept in the data folder, at `shared/<workspaceId>/`, and what each machine's mirror last agreed on is kept in `shared-sync/`. Neither is sent to the object store. A deployment that keeps the data folder, or copies it, keeps them. The machines it starts need no setup: each host keeps its mirrors in its own folder, or in `GRAM_HOST_SHARED` when that is set, and the server brings them in step over the host's connection. When a machine is readied to stop (`/machines/stop/prepare`), its mirrors are brought in step once more, for up to 15 seconds, before the answer.

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

**Choices before it starts.** A provider may offer the person things to pick first, such as the
machine's size or processor, within whatever limits it keeps. The server asks it, at most every 30
seconds per person, when that person reads their status:

```http
POST <GRAM_HOST_PROVIDER_URL>/hosts/choices
{ "owner": "<person>" }
→ { "choices": [ { "id": "size", "label": "Size", "default": "small",
                   "options": [ { "id": "small", "label": "Small", "detail": "1 CPU · 2 GB" },
                                { "id": "xlarge", "label": "Extra large", "available": false,
                                  "note": "Above your team's limit" } ] } ],
    "note": "Your organisation allows up to Large." }
```

A 404, or no answer, offers nothing, and the machine starts as before. Ids are short
(`[a-z0-9-]`, at most 40), at most 6 choices of at most 8 options each; an option the person may
not pick is shown, locked, with its note. They are asked again after a start. The New forms show
them on one **Runs on** chip, named by the first three choices (an option's `short` label where it
has one), and its popover changes any of them, whether the machine runs or not. The person's
start then says what they changed from each `default`,
`{ "repositories": [...], "choices": { "size": "large" } }`, and the provider gets it in
`options.choices`; a choice left alone follows the provider's default. The proof binds the
person's own body, so a provider reads the picks from `proof.body` and checks them against its
limits again: the chip's locks are only a courtesy.

A provider can also say, per choice, what the person's machine has now (`current`) and what the
default is when the person keeps no pick of their own (`fallback`); `default` is then that person's
own pick where they keep one. With `"keeps": true` on the answer, it keeps picks for people:

- each choice says whether its value is the person's own or the default, with a way back to the
  default, and "Reset all to defaults";
- a start may carry `"keep": true` ("Keep as my default"), passed on in `options.keep`: the
  provider keeps the picks in it as that person's own, and a pick equal to `fallback` drops theirs;
- `POST /machines/on-demand/preferences` with `{ "choices": {...} }` keeps picks without a start.
  It reaches `POST <url>/hosts/preferences` with `{ owner, choices, proof }`; a 404 there means
  the provider keeps none.

**Starting it again with other picks.** A person whose machine is online and who changes a choice
it has (`current`) is offered to start it again with them: their start carries `"restart": true`,
and reaches the provider with `options.restart` even though the machine is online. The provider
decides how: readying the machine to stop (`/machines/stop/prepare`), keeping its disk, and
reporting progress as for any start. Without `restart`, a start of an online machine asks nothing.

`POST /machines/on-demand/stop` asks `<url>/hosts/stop` the same way, and
`GET /machines/on-demand/status` answers the person with their own machine, the start's progress
and the provider's choices.
Nothing else starts one: an agent, a skill or a repository's instructions have no path to these.

**The provider registers the host** as any provisioned host ([Provisioned hosts](PROVISIONED_HOSTS.md)),
naming the person in `owner` and `onDemand: "personal"`. From then on:

- a thread that person starts with no machine named goes on their own machine while it is online,
  and on no other machine: with none of theirs online they are asked to start it (the composer's
  start card), never placed on a shared host or one started for something else;
- a host started for the threads placed on it by name (`onDemand: "thread"`, an automated run's,
  say) takes only those threads and their workers. It names its `owner` as every host started on
  demand does: a person's subject, or one no person signs in with, such as the run's own, with
  the one person who may reach it besides in `person`. With an owner of no person's, its threads
  and their agents link to nothing of that person's;
- a worker goes on its orchestrator's machine: when it names none, and when it names "local" (this
  server runs nothing itself). It names another machine only if that machine is the same person's
  own; a machine started for other work, another person's, or (on a headless server) one that says
  no kind is refused before any approval card or checkout;
- a host started for one person is never anyone's default, and work that names it for anyone else
  is refused;
- a thread is its host's owner's, and nothing else makes it anyone's. Threads that work together
  are one person's: a worker is spawned only on a host of its orchestrator's owner (or on no
  one's under no one's), a thread joins an orchestrator only on such a host, and a thread moves
  only onto a host of the same owner. So a workspace's orchestrator and its workers never span
  two people;
- ownership is checked at two places that every path passes:
  - **where a host or session is reached.** Machine lookup (every terminal, by thread or by
    terminal id, a kept one included; its Sign in shell; keystrokes; files; git; folders) and
    session opening refuse another person's host. Deliveries to a session already open (a send,
    steer, notice, interrupt, answer, restart, fork, close) are refused for another person's
    thread, in any route: an RPC, `POST /asks/answer`, a workspace's task or an agent's tool. An
    RPC that names a thread or a workspace is resolved to its owner first, and so is the target
    of what names it otherwise: a closed thread reopened (its stored record), a workspace saved
    or edited (its orchestrator). Changes to a thread's record or session outside a delivery (an
    archive, directory grants, a reload, a queue edit) pass the same rule. A reopened thread
    comes back on its own host, and links again only to threads of the same owner. Another
    member still reads what the workspace shows; a call with no signed-in person reaches no
    one's host. A host started on demand that names no owner (registered by an older build) is
    reached by the server's own work alone. The server's own work is told so explicitly, where the
    server starts: a call that says nothing of whom it is for is no one's;
  - **where work is kept for later.** Durable work records who it was written for, and every
    attempt, a retry after a restart included, runs as them, never as the server's own. A
    thread's queued input keeps its writer beside it (whoever wrote, edited or replaced it last),
    and each item is admitted again as its writer just before it is sent, on a live session or
    after a restart; one whose writer may no longer reach the thread is dropped, and one kept from before writers were recorded is taken
    as no one's in particular. An owed answer to a worker's question that its maker may no longer
    give is settled undelivered;
- an agent's tool call is made for its own thread's host's owner. It is never read from the call's
  input, nor taken from whoever's request began the turn;
- some orchestration features don't work on a person's host in this version, and are refused
  there: feature stages and groups, and holding a low-priority spawn until a usage limit resets
  (the spawn starts or asks, as a normal one does);
- a person with no machine of their own is told to start one, where before they were told to join
  one.

**The provider reports progress** while it starts the host, on `POST /embed/v1/hosts/progress`
with `{ owner, hostKey, phase, step?, message? }`. `phase` is one of `starting`, `booting`,
`joining`, `ready`, `stopping`, `stopped` or `failed`. Only a host key the server asked for, for that
owner, is taken: anything else is `404`. Progress is kept in memory, for the person's status.

### Workers' own machines

An orchestrator on a person's host may ask for a machine of a worker's own, through `spawn_worker`'s
`sandbox`: `{own: true, size?, architecture?, isolation?, environment?}` asks for one (each by the
provider's own id for it; `isolation` is how strongly it is kept from other machines), `{shareWith}` places the worker on one
it already has (by machine name or a worker's thread id), `{shared: true}` packs it onto any of
its shared machines with room ([several workers on one machine](#several-workers-on-one-machine)),
and `{own: false}` keeps the worker on the orchestrator's machine. Left out, the workspace's
default applies, which unset is the orchestrator's machine. `reason` says in a sentence why the
work needs that machine; the worker keeps it with the machine, how it was packed and what was
named as `spawnedBy.placement`, and `list_workers` gives it on the worker's row. This is the one path by which an agent, not a person's own request, starts a
host, so the provider holds it to what the person and their organisation allow:

- the server asks `POST /hosts/start` with `{ kind: "worker", owner, name, options: { orchestrator,
  title, choices: { size?, architecture?, isolation?, environment? } } }` and no proof. `owner` is the owner of the
  orchestrator's own host, never read from the call. `name` is `worker-` and 10 hex characters,
  the same for a retry of the same spawn, so a provider should treat a second ask for a name it
  holds as the same machine;
- `200` starts it. The provider registers it on `/machines/provision` under that `name`, with
  `owner` and `onDemand: "worker"`, and the server waits up to five minutes for it to come online;
- `409` is over the person's total: `{ message, asked?, inUse?, total?, machines? }`, CPU and memory
  as `{ cpu, memoryGb }`, and the worker machines the person has as `{ name, size?, architecture?,
  running }`. Nothing starts: the orchestrator is refused with `over_total`, what is in use and
  which of its workers are on which machine, and decides whether to wait, share one, run the worker
  on its own machine or ask for less;
- `403` or `404` is not allowed, with the provider's `message`.

A worker host is placed on only by its owner's orchestrators, and is never anyone's default. Pausing
it when idle, waking it when its worker is messaged and reclaiming it later are the provider's.

When its work is over the server says so (`embedding/worker-machine-release.ts`). Every ten
minutes it looks at each worker host online for half an hour or more: once no open thread placed on
it is at work (every worker there is finished as the ledger reads it, with its pull requests merged
or closed, delivered or archived, or closed with its worktree), it asks `POST /hosts/release` with
`{ kind: "worker", owner, name, released: true, reason: "finished" }`. Should one be at work there
again, a worker reopened, it asks the same with `released: false, reason: "working"`, so the
provider keeps the disk. Each is told once; after a restart it may be told again, which a provider
takes as the same word. `404` means the provider keeps none of this.

A worker host can hold a larger size for a while (`request_resources`,
`orchestration/request-resources-tool.ts`). A worker asks for its host before a heavy step,
such as a full check, a big build or a long test run. The server
asks `POST /hosts/resize` with `{ kind: "worker", owner, name, size, holdMinutes?, reason? }`. `size`
is one of the provider's size ids, or `null` to go back to the size the host started at. The
provider answers `200` with `{ state, size?, start?, until?, message? }`:

- `state` is `grown` (in force now), `waiting` (its node applies it once it has room), `releasing`
  or `released` (going back, or back), or `infeasible` (it can never hold that size, and kept the
  one it had);
- `until` is when the hold ends and the host goes back by itself.

Any other answer is a refusal, with the provider's `message`: over the person's total, past what
the organisation allows, asked too often, or `404` and `501` where hosts aren't resized. Which sizes
there are, and what each holds, are the provider's.

While a worker host is online with work, the server also measures, observe only, whether it could
have been paused (`embedding/idle-measure.ts`): every minute, whether each thread on it is at rest
with no queued send, open question, background task or busy terminal, no wake that reads the machine
itself, and a last save that reached the remote; which of those held it when not; and what each
wait waited for (the user, the orchestrator, CI or review, a run monitor, `schedule_wake`, a
provider limit, or unknown). Each cold wake is timed from the session that wanted the host to the
host's return, its folders being ready and the first turn, with a provider limit's wait counted
apart. The measurements are kept for two weeks in `remote-access/idle-measure.json`, each wake is
logged as `machine resume timing`, and an hourly `idle machine measurement` log line sums up the
last week and hour: eligible machine-minutes after a warm minute, minutes blocked by gate and
blocker, and the resume latency's p50 and p95. Nothing here stops or starts a host. Desktop-relayed
hosts are measured only while the desktop runs.

### Several workers on one machine

An orchestrator decides how tightly its workers are packed onto hosted machines, spawn by spawn.
A worker on a machine that is already running starts in seconds, where a new machine takes most of
a minute, and a reviewer placed beside its author can read the author's worktree (`readAlso`).

| `sandbox`                             | Where the worker runs                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `{own: true, …}`                      | A new machine of its own. Another worker is placed there only by naming it.                              |
| `{own: true, exclusive: true, …}`     | A machine of its own that is never shared.                                                               |
| `{shared: true, …}`                   | Any of the orchestrator's shared machines with room and the same picks; with none, a new shared machine. |
| `{shareWith: <thread id or machine>}` | The machine named.                                                                                       |
| `{own: false}`                        | The orchestrator's own machine, whatever the default says.                                               |
| left out                              | The workspace's default (`workerPacking`): `orchestrator` unless the user set `shared` or `own`.         |

- **Opt-in.** No worker goes on a machine another worker is on unless its spawn says so
  (`shareWith`, `shared`) or the workspace's `workerPacking` does. A workspace that sets nothing
  behaves exactly as before. With `shared` or `own` set and no provider offering machines, a spawn
  with no `sandbox` runs on the orchestrator's machine as before.
- **One orchestrator's workers only.** A machine is placed on only by the orchestrator whose
  workers are on it: naming one that carries another orchestrator's worker is refused.
- **The shared pool.** A machine is one of an orchestrator's shared machines once a worker was
  placed on it with `shared`. A spawn joins one with the same named picks (size, architecture,
  isolation, environment) that has room. Machines started with `own` are reached only by name.
  Spawns that come while a new shared machine is still coming up join it, so a burst fills one
  machine instead of starting several: each takes a seat as it is resolved, before any approval
  card, and a seat never used lapses after ten minutes.
- **The cap.** A machine carries at most what its provider says a machine of that size is for,
  lowered by the workspace's `workersPerMachine` (1 to 8), and 4 where the provider says nothing.
  Counted: the orchestrator's open workers there that the ledger doesn't read as finished, and
  the seats of spawns under way. A named machine with no room is refused with who is on it.
- **`shareWith` checks its picks.** A size, architecture, isolation or environment named with it
  that differs from what the machine was started with is refused; naming none takes the machine
  as it is. A machine started `exclusive` is never shared, and a worker placed exclusive is never
  moved onto a machine it would share.
- **The ledger.** `list_workers` gives each worker on a machine its `packing` (`own`,
  `exclusive`, `shared`, `named`) and the other unfinished workers there (`sharesWith`), and each
  machine its `workers`. `worker_machines` gives each machine's cap, room, size and who is on it,
  to an orchestrator for all of its machines and to a worker for its own.

**What workers on one machine share.** Everything but their worktrees. They run as one user in
one container: one home folder, one temp folder, one process table, one set of ports, one disk
and the machine's memory and CPU. A worker can read and change another's files, read what
another's tools stored or exported, and signal its processes. Each has its own worktree in the
machine's clone, and the prompt tells a worker on a shared machine to bind ports of its own, to
install nothing globally and to leave other workers' folders alone, which guards against
accidents and nothing more. Nothing here limits one worker's memory or CPU: a build that
outgrows the machine is the provider's to kill, and a worker asks for room first
(`request_resources`, which on a shared machine is that worker's own hold). So work that reads
what outsiders wrote (web pages, other people's issues or pull requests), or that holds a secret
of its own, gets `{own: true, exclusive: true}`. Separating workers on one machine (a home and a
temp folder each, confinement to their own folders) is not built.

**What the provider keeps.** A provider may keep who is on each machine, and then holds a machine
to rules this Gram alone could get wrong. It says so in its choices answer:

```json
{ "sharing": { "workers": { "large": 4, "xlarge": 8 }, "size": "large" } }
```

`workers` is how many workers a machine of each size is for, and `size` the size a machine
starts at when none is named. A provider that says nothing of `sharing` is sent none of what
follows, and this Gram's own cap is all that bounds a machine.

- `POST /hosts/start` carries `options.sharing: { mode }`, `own`, `exclusive` or `shared`, which
  the provider keeps with the machine.
- `POST /hosts/workers` `{ kind: "worker", owner, name, orchestrator?, attach?: { worker,
  environment? }, detach?: [seat] }` takes a seat for a worker (`worker` is an id this Gram makes
  for it, kept as `spawnedBy.placement.seat`), gives seats up, or with neither reads them. `200
  { workers, cap?, size?, mode? }`. `409 { code, message, cap?, workers? }` refuses the seat:
  `machine_full`, `exclusive`, `other_orchestrator`, `environment_mismatch` or `released`. The
  spawn is then refused in the provider's words, and a machine it started is given back. `404`
  or `501`: it keeps none.
- `POST /hosts/machines` `{ kind: "worker", owner }` lists the person's worker machines: `{
  machines: [{ name, size?, held?, architecture?, isolation?, environment?, running, mode?,
  cap?, workers, usage?: { cpu, memoryGb } }] }`.
- `POST /hosts/resize` carries `worker`, the asking worker's seat: the hold is then that
  worker's, and the provider has the machine hold the largest of its workers' holds.
- `POST /hosts/release` may answer `{ applied: false, code: "occupied", workers }`: workers still
  have seats there, and the machine is kept. Every pass this Gram looks at the seats of each
  machine a worker of its has one on and gives up those whose worker's work is over, once a seat
  was nobody's on two looks in a row (a spawn takes its seat a moment before its worker exists).
  So a machine is released only after its last worker is done.

A hosted server the desktop is signed in to takes the same as `…/workers` and `…/machines`, with
no `kind` or `owner`.

### Moving a worker

`place_worker` moves a worker to another hosted machine, with `to` in `sandbox`'s shape. An
orchestrator moves its own workers. A worker may only ask `{own: true}` for itself: packing
workers together is its orchestrator's decision, since a worker that could put itself beside
another could reach that worker's files.

A turn can't be carried: its processes, its terminals and the agent's own session file stay on
the machine. So a worker moves between turns. One at rest (cold, idle or failed) moves at once.
One in a turn is queued and moves when it next rests, looked at every half minute for a day;
`cancel: true` drops it. Queued moves are kept in memory and are lost when this Gram restarts.

The move uses what a machine's stop does (`orchestration/worker-moves.ts`): the worker's folders
are kept at the remote on its hidden ref (`host.stop.keep`), the machine it goes to makes them
again from the remote and that ref (`host.stop.restore`, a host that names `wip-restore-ref`),
and only then is the thread pointed there. Its next session opens on the new machine and reads
the recent turns, as after a machine came back on another disk. A step that fails leaves the
worker where it was. The folder it leaves is removed only when nothing in it is uncommitted.
Folders it was only let read on the old machine (`readAlso`) are let go.

Not moved: a worker to or from its orchestrator's own machine or this one, a worker in a
worktree it made itself, and one whose folder wasn't made from a clone its machine keeps.

### Workers' own machines for a desktop orchestrator

The desktop app's orchestrators can have the same machines, from a hosted server the app is signed
in to, when that server offers them ([design](design/desktop-worker-machines.md)). The server says
so in its discovery document with `worker_machines_endpoint` and `worker_machine_connect`, both on
its own origin, and the app then asks for the `machines:workers` scope. The desktop's Gram server
asks the app over its parent port, and the app makes each call with the person's DPoP-bound token:
`POST <worker_machines_endpoint>/choices` (its picks, as `/hosts/choices` answers them, and the
models its machines run as `models: [{ agent, id, resolvedId?, label? }]`: a worker on another is
refused before a machine is asked for), `/start` `{ name, title, orchestrator, choices }`,
`/status` `{ name }`, `/release` `{ name, released, reason }` (a `404 { code: "not_found" }`
means the machine was reclaimed there: it is forgotten here; a `503` is asked again after a wait
that doubles; `known: false` is told again next pass) and `/stop` `{ name }` (answered
`{ stopped }`: `false`, or a 404, when it holds no machine of that name). No call names an
owner: the server takes the person from the token, and answers each as `/hosts/*` does (`409` over
the person's total, `409 { code: "name_in_use" }` for a name a reclaimed machine or the person's
hosted worker machine has, which is refused, or `409 { code: "released" }` for a machine still
held as released, which the desktop takes back with `/release` `released: false` and asks once
more; `403` or `404` not allowed).

The desktop can't be dialled, so the machine's `gram-host` is provisioned for the hosted server's
own origin and dials it at `/host/connect`; the app dials `worker_machine_connect?name=<name>`, and
the server pairs the two only for the machine's owner. Its first frame to the app is
`{"dial":{"headers":{…}}}`, the four `x-gram-host-*` headers the host signed its dial with; every
frame after it is the host's, both ways, unchanged. `/status` answers `{ phase, message?,
publicKey?, platform? }`: once it carries the host's key, the desktop registers the machine itself,
as a worker host that came through that server, and takes its dial only from that server's relay.
A machine that isn't online in five minutes is stopped with `/stop`. A thread on such a machine is
shown as running on the server's machine, by the server's `name` and its optional `logo_uri`: an
image on its own origin, which the app fetches without the sign-in and keeps only when its bytes
are an SVG, PNG, WebP or JPEG of at most 16 KiB, or a `data:` image of the same. Without one the
app draws the first letter of `name`. Release is the same pass as
above, through the app. Its sessions' app tools never go to the server: they are carried over the
host's own connection (`app-tools-tunnel`), to the desktop that placed them.

### A workspace's own machine

A workspace with an environment of its own (`environment`, which the app offers through the web
app's `environments` mount option, [EMBEDDED_WEB_APP.md](EMBEDDED_WEB_APP.md)) runs its
orchestrator, and so its workers, on a machine of its own, started in that environment, instead of
on the person's own. A workspace without one runs on the person's own, as before. The person starts
it, as they start their own:

- opening its orchestrator with that machine not running is refused with a message that begins
  `WORKSPACE_MACHINE_NOT_RUNNING`. The web app then asks `POST /machines/on-demand/start` with
  `{ workspace }`, as the person, waits on `GET /machines/on-demand/status?workspace=…` until it is
  online, and opens the orchestrator again;
- the server asks `POST /hosts/start` with `{ kind: "workspace", owner, name, options: { workspace,
  title, environment, repositories }, proof }`, the proof as for a person's own. `name` is
  `workspace-` and 10 hex characters, one per person and workspace, so a provider should treat a
  second ask for a name it holds as the same machine, woken if it is paused. `environment` is the
  app's own id, as its list gave it: the provider checks the person may use it. A workspace with no
  environment of its own is `404`, and the provider is not asked;
- the provider answers `{ hostKey }`, reports progress with `workspace` beside `owner`, and
  registers the machine on `/machines/provision` under that `name`, with `owner` and
  `onDemand: "thread"`. Online, the orchestrator is placed on it, and its workers with it.

A change of a workspace's environment applies from its machine's next start. Pausing it when idle,
waking it and reclaiming it later are the provider's.

## Memory updates on a headless server

A headless server runs memory updates as the desktop app does, from the same Settings, with Review
as the default and automatic runs after a number of completed threads. What differs is where the
agent runs:

- **Its session goes on the workspace's orchestrator's machine.** The memory update's folder (its
  snapshot of memory and transcripts, and the candidate it writes) stays in this server's data
  folder, and the agent reaches it only through its app tools (`dream_read`, `dream_write`,
  `dream_check` and the rest), over the machine's MCP endpoint, as every session there reaches its
  tools. Nothing of the workspace's transcripts is copied to the machine's disk; what the agent
  reads passes through its session as any turn does.
- **Claude Code only.** Its memory update has no native tool, no settings and no MCP server but
  Gram's, so it never needs the folder itself. The host opens it in an empty folder made for it
  and removed when it ends (`dream-sessions` in the host's hello; an older host is refused, and
  says to update it). Codex's memory update reads and writes its folder with native tools, so a
  headless server refuses one and asks for a Claude Code model.
- **Whose machine.** The orchestrator's machine's owner may read the workspace, and a memory update
  reads only threads everyone who sees the workspace may (`readableBy`), so nothing reaches a
  machine whose owner couldn't read it. An automatic run is made for that owner: their machine's
  models decide whether it can start, and its session waits for a stopped machine as any thread's
  session there does. With
  no orchestrator on a machine yet, a manual start is refused and an automatic one waits, keeping
  its count.
- **The server needs `/usr/bin/python3`**, as the desktop app does, for the helper that reads and
  writes the memory update's files through directory handles. The control-plane image has it.

## A note for a thread

The platform can give one thread a note, which its agent takes as a turn of its own once the thread is free, as it takes any input the server writes itself. It wakes a thread at rest for something that happened outside it, such as an answer given elsewhere to what the agent was waiting on.

```
POST /embed/v1/thread-notes
{ "threadId": "...", "key": "ask-41:answered", "text": "The approval you asked for was given. Try the action again." }
→ 200 { "delivered": true }
→ 202 { "delivered": false, "queued": true }
```

- A thread with no session has one opened for the note. One that is working takes it after its turn; one waiting on an approval or an answer takes it after that.
- The call waits up to 20 seconds for the agent to take the note, and answers `202` if it hasn't yet. The note goes on waiting.
- `key` names the note. Sent again while it waits, it is not queued twice; sent again after the agent took it, it answers `delivered` and is not sent again. So a caller that sends until it hears `delivered` delivers it once. Neither is kept past the process: a note still waiting when the server stops is lost, and the caller, which never heard `delivered`, sends it to the server that starts.
- The agent reads the text after a line saying it comes from the app the workspace runs in and not from a person in the thread. It grants nothing.
- `404` for a thread the server doesn't have, `409` when the thread couldn't take it (it ended, or its agent couldn't start), `400` for a body that isn't one. `text` is 1 to 4000 characters.

## Before an idle stop

A deployment that stops this server when nothing has used it for a while asks it first, so that
what an [idle compaction](AGENTS_AND_FEATURES.md#idle-compaction) would have done at its time is done
before the stop, while the threads' prompt caches are still warm.

```
POST /embed/v1/idle-stop
{}
→ 200 { "compacting": 2 }
→ 200 { "compacting": 0 }
```

- Every idle compaction waiting for its time whose deadline hasn't passed goes now, through the same
  holds: a draft, a typing person, a paused workspace, a held worker or an open question keeps it
  waiting, and such a thread isn't counted. Nothing else changes: no setting, no other thread.
- `compacting` is how many threads are compacting or about to. Ask again before stopping, and stop
  once it is `0`. A compaction whose end the server hasn't seen after ten minutes isn't counted, so a
  stop never waits on one for longer.
- The compaction is a turn like any other: its status and usage reach the event sink, which a
  deployment that reads activity from them will see.
- It stops nothing itself. Called on a server that will go on running, it only compacts sooner.

## A person's message for a thread

The platform can write in a thread for a person it signed in, and stop the thread's turn, so that a person's own API or MCP client can do what they would do in the web app without a browser.

```
POST /embed/v1/thread-messages
{ "threadId": "...", "person": { "id": "user-7", "name": "Ada" }, "key": "m-1", "text": "Look at the tests.", "mode": "queue" }
→ 200 { "queued": false }
→ 200 { "queued": true }

POST /embed/v1/thread-interrupt
{ "threadId": "...", "person": { "id": "user-7" } }
→ 200 { "interrupted": true }
```

- The message is the person's own, as one they typed: it is shown as theirs, recorded as their `thread.send` or `thread.steer`, and `person.id` is the id the proxy's statement gives them ([sign-in through a proxy](DOCKER.md#sign-in-through-a-proxy)). The platform decides that the person may write in the thread; the server trusts it to say who they are, as it does for a thread started for someone.
- `mode` is `queue` (the default: sent now on a thread at rest, else after the running turn, `queued: true`), `steer` (into the running turn, cancelling nothing) or `interrupt` (the turn stops and the agent answers this). A steer the thread can't take now, with no turn running or an agent that can't, is sent as `queue` would send it.
- `key` names the message, 1 to 128 letters, digits, `_` or `-`. Sent again, it is the same message and answers what the first answered, so a caller that retries delivers once. Unlike a note's, it is kept with the thread.
- A thread on a machine started for one person is written in and stopped only for that person: anyone else gets `409` with why.
- A stop is a person's Stop: a thread waiting out a provider limit stops waiting too, and a turn that meets a limit as it stops ends with the limit as its error. Nothing resumes the thread on its own after it; the person's next message does.
- `404` for a thread the server doesn't have, `409` when it can't take the message now (it ended, or its agent couldn't start), `400` for a body that isn't one. `text` is 1 to 20,000 characters.
- `conversation` (`{ "id", "label"? }`) says the message came from one of the platform's own conversations: see [Conversations](#conversations).
- `attachments` (`[{ "name", "mediaType", "data" }]`, `data` the file's bytes in base64) are files sent with the message, at most 10 and 32 MB together, each at most 20 MB. They are kept in the thread's attachments folder, as a file a person attaches is, and given to the agent the same way: an image as an image the model sees, any other file as one it can read. The platform chooses which kinds of file it sends; the server checks only the count, the sizes and that each is a media type. Each is written only once the caller may write in the thread, inside the key's one delivery, at a path holding its digest: sent again under its key the message names the same files, and other bytes under a used key are another message, refused with `409`. The route takes a body of up to 44 MB.

## Conversations

A platform that brings people's chats, issues or mail threads to Gram names each one with an id of its own and gives it on the messages it sends in. Gram ties the conversation to the thread that answers it, and that thread replies there through the [event sink](DOCKER.md#event-sink).

```
POST /embed/v1/thread-messages
{ "threadId": "...", "person": { "id": "slack:U7" }, "key": "Ev1", "text": "Who is on call?",
  "conversation": { "id": "slack:T1/C2/1700000000.000100", "label": "Slack · #runbooks" } }
```

- **The id** is the platform's, 1 to 200 printable characters with no space, and opaque to Gram. `label` (at most 120 characters) is how a person and the agent read where it is. The transcript shows "From Slack · #runbooks" under the message, and the agent reads a line above it naming the conversation and how to answer it.
- **Who owns it.** The thread the platform first sends a message from it to owns it (`Thread.conversations`), unless another open thread already does: then the message is still delivered, and the agent is told another thread answers there. A thread owns at most 50.
- **A reply** is the owner's `reply` tool, naming the conversation. It is sent as `conversation.reply` `{id, conversation, text, files?}` on the event sink, for the platform to post; `id` is the reply's own. A thread that doesn't own the conversation is refused, so text one conversation's people wrote can't make an agent post in another. A thread at `supervised`, by its profile or its workspace, asks the user before each reply, unless the decision hook decided that reply: the conversation is the platform's, so the hook's answer (below) says whether a person approves it, and Gram raises no card of its own. Where the hook is absent or off, the reply asks at `supervised` as before. With no event sink configured, the tool is absent; with hosted features off, it refuses.
- **Asked first.** With a [decision hook](DOCKER.md#decision-hook), every reply is asked about as `conversation.reply` before anything is sent, with `{conversation, text, files?}` as its detail: the platform's rules can let it through, refuse it or have a person approve it.
- **Files with a reply.** `reply`'s `files` names up to 10 files, 25 MB together, in the thread's folder (its checkout, or on Gram's own machine its attachments too): nothing past it is read, whether named by an absolute path, `..` or a link, and a file that may hold credentials is refused. They are read once, before the hook is asked, so what is decided on is what goes out. A reply's `key` names one reply for good: the same call again is that reply, and other text or files under it are refused. Each is named in the event's `files` as `{name, mediaType, size, sha256}`, and kept for 7 days, outside the thread's folder so a worker that closes as it replies leaves them behind. The platform reads each back in its place in `files`:

```
POST /embed/v1/conversation-files
{ "reply": "<the reply's id>", "index": 0 }
→ 200 { "name": "chart.png", "mediaType": "image/png", "size": 48213, "sha256": "…", "data": "<base64>" }
```

`404` when the server keeps no such file, or its bytes no longer match its `sha256`.

- **Handing one on.** An orchestrator hands conversations it owns to a worker it spawns (`spawn_worker`'s `conversations`) and takes one back from its worker (`take_conversation`). A worker's go back to the orchestrator that spawned it when it closes, or to nobody when that orchestrator is gone. Each change is sent as `conversation.owner` `{conversation, owner?}`: send the conversation's next messages to `owner`.
- **What it is not.** Ownership says who may reply, not who may read: the platform chooses which thread a message goes to.

## A fresh orchestrator session for a person

The platform can start a workspace's orchestrator on a fresh session for a person it signed in, as Fresh session does in the web app ([a fresh orchestrator session](AGENTS_AND_FEATURES.md#a-fresh-orchestrator-session)).

```
POST /embed/v1/thread-fresh-session
{ "threadId": "...", "person": { "id": "user-7", "name": "Ada" }, "checkpoint": true }
→ 200 { "started": true }
```

- `threadId` is the orchestrator's thread. `checkpoint` (default `true`) has it save to memory first; `false` is a hard cut: its running turn stops as Stop does and the fresh session starts at once. The answer comes once the handoff is under way, not once it is done.
- It is recorded as the person's `orchestrator.handoff`, and a thread on a machine started for one person is reached only for that person.
- `404` for a thread the server doesn't have; `409` for one that isn't its workspace's orchestrator or can't take a fresh session now (another handoff running, parked, ended); `400` for a body that isn't one.

## A person's thread started in repositories

The platform can start a thread for a person it signed in, in one or more repositories, as New task would start one: a new worktree in the first repository, one on the same branch in each other, and the person's first message.

```
POST /embed/v1/thread-starts
{ "person": { "id": "user-7", "name": "Ada" }, "key": "s-1",
  "repositories": ["acme/api", "https://github.com/acme/web"], "text": "Rename the endpoint in both.",
  "title": "Rename the endpoint", "branch": "rename-endpoint", "model": { "agent": "claude", "model": "opus" },
  "mode": "bypassPermissions" }
→ 200 { "threadId": "...", "created": true, "branch": "rename-endpoint" }
```

- `repositories` names 1 to 8 repositories as `owner/name` or a git URL, the one the thread works in first. Each is cloned as `projects.clone` clones it, or taken as it is when it is already there; a server that runs no work itself files it as an origin that the machine clones.
- The thread is placed as one the person started: on their own machine where machines are started for one person. With none of theirs running, it is refused with `409` and why.
- `branch` defaults to `thread/<the thread id's first 8 characters>`; `title` to one made from the message; `model` to the saved default; `mode` to the saved default permission mode. `mode` is one New task offers: `default`, `acceptEdits`, `plan`, `auto` or `bypassPermissions`.
- `key` names the start. Sent again, it answers the thread it made, with `created: false`, and makes nothing.
- The thread is recorded as made by the person (`thread.create`). A repository that can't give it a worktree makes nothing: `409` with why. `400` for a body that isn't one.

## A thread moved here from another Gram

The platform can bring in a thread that a person moved here from another Gram, such as their own
laptop's, as a bundle that Gram exported (`POST /threads/export`, [moving a thread](design/move-a-thread.md)).

```
POST /embed/v1/thread-imports
{ "person": { "id": "user-7", "name": "Ada" }, "bundle": { ...ThreadBundle }, "from": "Ada's laptop" }
→ 200 { "threadId": "...", "notes": ["Its uncommitted edits are back as uncommitted files."] }
```

- The thread is placed as one the person started: on their own machine where machines are started for one person, and refused with `409` while none of theirs runs. A server that runs work itself clones the repository here instead.
- Its folder is made from the bundle's repository, its edits read only from the ref and the commit the bundle names (the machine's host needs `wip-restore-ref`). A branch that moved since, or a ref that isn't there, makes nothing.
- A bundle is untrusted input: an id Gram doesn't make, a thread or turn already here, or a newer bundle format is refused before anything is written. The mode, the model's profile, effort and speed are this server's. The thread keeps its id and is recorded as brought in by the person (`thread.import`).
- The same move sent again, as when the first answer was lost, answers the thread it made: same thread, same Gram, the same person, still here. Anything else already here is refused.
- The body may be up to 32 MiB. `notes` says what to tell the person. Then the platform asks the other Gram to settle its copy (`POST /threads/settle`).
- A thread that moved from here before comes back onto its read-only copy here, rather than being refused as already here, when the copy is the person's to read. On their machine its folder is a new one; its branch stays in the earlier folder when that one still holds it, and the new folder then works on a detached HEAD, which `notes` says.

### Bringing a thread back

The platform can take a thread back to a Gram of the person's: it asks for the bundle, gives it to
that Gram (`POST /threads/import`), and, once that Gram answers, asks this server to settle.

```
POST /embed/v1/thread-exports
{ "person": { "id": "user-7", "name": "Ada" }, "threadId": "..." }
→ 200 { "bundle": { ...ThreadBundle } }

POST /embed/v1/thread-settles
{ "person": { "id": "user-7", "name": "Ada" }, "threadId": "...", "exportedAt": 1763495000000, "to": "Ada's laptop" }
→ 200 { "settled": true }
```

- Either is `404` for a thread the person doesn't reach: on someone else's machine, or readable by someone else.
- An export is refused with `409` mid-turn, for a thread of a workspace, and for one that moved already. A thread on the person's machine has its edits kept and pushed by that machine (`host.stop.keep`); nothing else changes.
- A settle names the export's `exportedAt`: a thread that carried on since stays as it is, with `409`. Settled, the thread here is a read-only copy saying where it went.
- Whether a person may take work away is the platform's to decide before it asks. Both are recorded as the person's (`thread.export`, `thread.settle`).
- Only that person brings the copy back here later: a move in of a settled copy is refused for anyone else.
- On the Gram it went to, the import names the server it came from (`server`), and the thread says its copy there is still open until that Gram hears the settle went through (`POST /threads/settled-there`). Until then it offers to make the copy there read-only.

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

### A person's own settings

Most settings are one value for the server. A few are a person's own view of the app, named one by one in the contract (`PERSONAL_SETTINGS` in `packages/contracts/src/settings.ts`); today that is `layout.grid`, the pane grid and its focused pane.

- The server keeps one value of each per person (`person_settings`). The person is whoever the fronting proxy signed in (`sub`), or the one local person where nobody signs in that way, which is the desktop app: there nothing differs from before, and the grid it had saved is that person's.
- `settings.get` answers the shared settings with the caller's own laid over them. A personal setting is read from the person's own rows only: someone who has saved none has none, whatever the shared row once held.
- `settings.set` writes the personal part of a patch for the caller and the rest for everyone. A change to a personal setting sends `settings.changed` to that signed-in person's connections and to nobody else's.
- A viewer may send a patch of personal settings only. One that names anything shared is refused whole.
- A supplied setting wins over a person's own as over the shared value, and a change to it is refused the same way.

### A person's own Waiting on you

With sign-in through a fronting proxy, an item of Waiting on you names the person it waits on (`person` on the item, and on its `wait_items` row), where the server knew one when it was added:

- one the agent adds (`wait_on_user`) or the helper suggests waits on whoever typed the thread's latest message;
- one a person adds from a message waits on that person;
- an item added when no signed-in person had written in the thread (a worker an orchestrator started, a thread only a wake has written to), and every item from before items named anyone, waits on anyone.

An item keeps who it waits on when it is updated, kept, resolved or reopened.

- A signed-in person is sent, and `thread.listWaits` answers them, their own items and the ones for anyone: in `threads.snapshot`, in `thread.waits` and in what the helper resolved lately. So the tray, the sidebar count and the board hold nobody else's.
- This is what a person's list shows, not a permission. The chip an item draws in the transcript is the thread's, and everyone who reads the thread sees it; `thread.resolveWait` and `thread.keepWait` take an item's id from anyone who may write.
- The agent's side is the thread's: `list_waits`, the note it gets with the next message and the limit of open items count every item, whoever each waits on.
- Where nobody signs in that way, which is the desktop app, no item names a person and nothing differs from before.

### How an item ends

An item of Waiting on you ends one of three ways, recorded on the item as `ending` (absent is `done`, as on every item resolved before endings were):

- **done**, by the user's Done (`thread.resolveWait`), or by the agent's `resolve_wait`;
- **dismissed**, by the user's Dismiss: `thread.resolveWait` with `dismiss: true` and an optional `note`, for an item that no longer makes sense and wasn't done;
- **withdrawn**, by the thread that added it (`resolve_wait` with `ending: "withdrawn"`) or by its workspace's orchestrator, which passes the item's `threadId` and is named in `resolverThread`.

The `data-wait` chip keeps `state: "done"` for all three and adds `ending` for the other two, so a client that knows only `done` still draws it as resolved. The thread that added the item hears which with its next message, as it hears of Done; an orchestrator's digest lists what the user dismissed, and what a worker withdrew itself, apart from what they marked done. `list_waits` answers a resolved item's `state` as its ending.

`resolve_wait` with `ending: "deleted"` takes an item off every list: it is resolved as withdrawn if it was open, so its chip reads withdrawn, and kept only as the record of what it was, with `deletedAt` and a `deleted` entry in its `history`. `thread.listWaits`, the tray, the counts and the digest leave it out; `list_waits` with `state: "deleted"` reads it. Nothing is removed from `wait_items`.

### An orchestrator's view of its workspace

The orchestrator holding a workspace manages the Waiting on you of every thread in it (`workspaceId`): its workers, live or archived, those an earlier orchestrator spawned, threads that joined it, whoever added the item, the user included. A thread in another workspace, or in none, is refused, as is any thread that isn't that workspace's orchestrator naming another thread.

- `list_waits` without `threadId` lists the whole workspace's items, each with the `threadId` and title of its thread and `archived` or `merged` when that thread is archived or its pull request merged, so the item is likely stale. With a `threadId` it lists that thread's, the orchestrator's own included. Reading a worker's items doesn't mark them heard for the worker.
- `wait_on_user` with `threadId` and `id` edits another thread's open item in place: same id, same anchor, its chip restyled where it is. `resolve_wait` with `threadId` withdraws (the default), marks done or deletes one.
- Every edit, by anyone, adds an `edited` entry to the item's `history` with who made it (`by`, and `thread` when another thread did) and what it said before (`from`); the last `WAIT_HISTORY_MAX` are kept. The item's own agent hears of an orchestrator's edit or deletion with its next message.
- The digest counts every open item in the workspace. It names them all on a boot, and otherwise those of an archived or merged thread, flagged likely stale. `archive_thread` answers the open items the archived thread still has (`openWaits`).
