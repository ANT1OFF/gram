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

- a thread that person starts with no machine named goes on their own machine while it is online,
  and on no other machine: with none of theirs online they are asked to start it (the composer's
  start card), never placed on a shared host or one started for something else;
- a host started for the threads placed on it by name (`onDemand: "thread"`, an automated run's,
  say, with or without an `owner`) takes only those threads and their workers;
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
    one's host;
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
