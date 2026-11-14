# Thread profiles

[Up: documentation map](README.md)

A thread profile is everything a thread is started with when something other than a person at the
composer starts it: a service Gram runs behind that turns its own templates into threads. The RPC
`thread.createFromProfile` takes one profile, whole, and starts a thread from it. It is one of the
[hosted features](DOCKER.md#hosted-features): with that setting off the call is refused and
nothing else in Gram changes.

The shape is `ThreadProfile` in
[thread-profile.ts](../packages/contracts/src/thread-profile.ts). It is decoded strictly: a key
the shape doesn't name is refused rather than dropped, so a supplier never believes something
was applied that this version doesn't know. A profile that is refused leaves nothing behind.

| Part         | What it is                                                 | What Gram does with it                                                                                                                                      |
| ------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`    | `1`                                                        | Refuses any other.                                                                                                                                          |
| `name`       | The profile's name                                         | The thread's title until it gets one of its own.                                                                                                            |
| `source`     | An id and a version, in the supplier's words               | Kept on the thread as given, so the supplier can tell which of its records a thread came from.                                                              |
| `agent`      | `claude` or `codex`                                        | The agent the thread runs on.                                                                                                                               |
| `charter`    | Standing instructions                                      | Added to the agent's system prompt at every session open, so it outlives a resume and a compaction.                                                         |
| `files`      | Text files, each at a path relative to the thread's folder | Written into the folder before the first session opens. `AGENTS.md` goes here.                                                                              |
| `skills`     | A name, a description, a body and further files each       | Written where the thread's agent reads a folder's skills: `.claude/skills` for Claude Code, `.agents/skills` for Codex.                                     |
| `model`      | A model, an effort, a gateway profile's id, fallbacks      | The thread's model. The gateway profile must exist here; its address and key are this Gram's settings. Fallbacks are recorded only.                         |
| `connectors` | One MCP server by name and address, or none                | Every session of the thread is held to that one server beside Gram's own, or to none, whatever the agent is configured with.                                |
| `autonomy`   | `supervised`, `publish` or `full`; `publish` when absent   | The thread's outward gate, as a workspace's autonomy sets a worker's.                                                                                       |
| `workplace`  | `none`, `scratch`, or one to eight repositories            | `none` and `scratch` get a new folder of the thread's own under the data folder. Repositories are cloned and the thread works in worktrees of them (below). |
| `input`      | The first message                                          | Sent once the thread exists. Without it the session opens and waits.                                                                                        |

## Asking again

A caller that may ask twice for the same start (a retry after a timeout, say) gives the thread
its id: `thread.createFromProfile({ profile, threadId })`, with a lowercase UUID it made itself.

- The first ask makes the thread with that id. Any later ask answers that thread as it is now and
  makes nothing, whatever profile comes with it. Two asks at once make one thread.
- The thread answered may be in error, when its agent couldn't open; it is still the thread.
- An id another kind of thread has is refused, and so is the id of a thread since closed.
- A start that failed left nothing, so asking again with the same id starts afresh.

## From a fronting platform's own service

A platform in front of Gram (see [fronted sign-in](REMOTE_ACCESS.md)) starts a thread with its own
signed statement for the path, role `service`, as it registers provisioned hosts:

```http
POST /threads/from-profile
Content-Type: application/json

{ "profile": { "version": 1, ... }, "threadId": "<lowercase UUID>", "hostId": "<machine id>" }
```

- The answer is `{ "threadId": "...", "created": true }`; `created` is false when an earlier ask
  under the same id made the thread. The shapes are `ProfileStartRequest` and
  `ProfileStartResponse` in `@gram/contracts`, the path `PROFILE_START_PATH`.
- `threadId` is required here, so a retried call never makes a second thread. It shares one
  starter with `thread.createFromProfile`: an id asked for either way makes one thread.
- `hostId` places the thread on that joined or provisioned machine, on any server, as a headless
  one places what names none. An unknown, unconfirmed or offline machine, or this one, is
  refused with nothing made. Asked again under the same id naming another machine than the
  thread's, it is refused rather than answered.
- A refusal is `409` with `{ "error": "..." }`; a body that isn't the shape, or has a key it
  doesn't name, is `400`. With the hosted features off the path answers `404`.
- A person signed in through the proxy is refused it, and so is a paired phone. The local app
  may call it with its own sign-in. Each service call is on the record with the thread it made or
  found, whether it made it, and its machine.

## Before its machine

A platform that starts a machine for each new thread can show the thread while the machine
boots: it starts the thread with its machine named later, starts the machine, and names it once
it is online.

```http
POST /threads/from-profile
Content-Type: application/json

{ "profile": { "version": 1, ... }, "threadId": "<lowercase UUID>", "machine": "later", "startedBy": "<person id>" }
```

- **What is made.** The thread, at once, and nothing else: no folder, no session. The answer is
  `{ "threadId": "...", "created": true, "awaitingMachine": true }`. The profile's `input` waits
  in the thread's queue, which is stored and survives a restart, and so does anything sent to the
  thread while it waits. Asked again under the same id, the answer is the same thread, as it is.
- **How it reads.** The thread carries `awaitingMachine` (`AwaitingMachine` in `@gram/contracts`)
  wherever a thread is read, its summary included: `since`, `startedBy` when one was given, and
  `failed` once no machine came. Its checkout is on the machine `awaited`, which is no machine's
  id, so a client that doesn't know the state shows it as a thread whose machine is away.
- **Whose it is.** `startedBy` is the id the fronting proxy states for the signed-in person. The
  first message is sent as theirs (`sentBy`), and until the thread is placed only they reach it.
  It is placed only on a machine started for them or for nobody. Without `startedBy` it is
  anyone's, as a thread on a machine started for nobody is. Leave it out where nobody signs in
  through a proxy: no call there is made as a person, so none would reach the thread.
- **What is refused.** A workplace of repositories: its checkouts are made on the machine, so
  start that thread once the machine is online, with `hostId`. `machine` together with `hostId`,
  and `startedBy` without `machine`. Each is `409` with nothing made.
- **Naming the machine.** `POST /threads/move-to-machine` with the thread's id, the machine's and
  the profile, as for a move (below). The machine's host makes the thread's folder with the
  profile's files, the thread is placed there, its session opens and the queue is sent; with
  nothing queued the session opens and waits. The answer is
  `{ "threadId": "...", "hostId": "...", "moved": true }`. Named again, at once or after a
  restart cut the first call short, it answers `moved: false` or places the thread then: the
  folder is made anew, and each queued message is sent once, as the same message. A naming that
  is refused (a machine that isn't online, one started for someone else, another profile than
  the thread's) leaves the thread waiting with its queue.
- **When no machine comes.** Nothing is dropped. A thread that has waited five minutes, as long
  as a session waits for a stopped machine, says so: `awaitingMachine.failed` gets when and a
  sentence for the person, and stays across a restart. The platform can say it sooner and in its
  own words, or that it is trying again:

  ```http
  POST /threads/machine-wait
  Content-Type: application/json

  { "threadId": "<lowercase UUID>", "failed": "The machine couldn't be started: no capacity." }
  ```

  With `failed` (at most 500 characters) the thread says that; without it the failure is cleared
  and the five minutes begin again. The answer is `{ "threadId": "...", "awaitingMachine": { ... } }`,
  and `409` for a thread that doesn't wait. Either way the thread keeps its queue, and naming a
  machine, however much later, places it and sends what waited. The shapes are
  `ProfileWaitRequest` and `ProfileWaitResponse`, the path `PROFILE_WAIT_PATH`; who may call it
  is as for a start.

- **In order.** Start the thread with `machine: "later"`; start the machine and
  [register it](PROVISIONED_HOSTS.md) with the same person as its `owner`, or with none; once it
  is online, name it. If it fails to start, say so on `/threads/machine-wait`; to try again, call
  that without `failed`, start another machine and name it.
- **With the hosted features off** all three paths answer `404`, and `thread.createFromProfile`
  takes no `machine`: it places the thread now, as before.

## Moving a thread to another machine

A machine started for one thread may go away for good: one with no disk of its own is gone once
it stops. The platform moves the thread onto another joined machine, with its own statement for
the path, as it starts one:

```http
POST /threads/move-to-machine
Content-Type: application/json

{ "threadId": "<lowercase UUID>", "hostId": "<machine id>", "profile": { "version": 1, ... } }
```

- **What moves.** A thread started from a profile whose workplace is a folder of its own (`none`
  or `scratch`) on a joined machine. A thread still waiting for its first machine is placed by
  the same call ([before its machine](#before-its-machine)), with none of the conditions below
  about the machine it is leaving: it is on none. A thread in repositories has work only its machine holds,
  and stays.
- **When it moves.** Only while its machine is away: it is asked before anything is made, and
  again just before the thread moves, so a machine that dials in meanwhile keeps its thread and
  what was made for it on the target is removed. `hostId` must be a joined machine, online now.
- **Whose it stays.** A thread is for the person its machine was started for. It moves only to a
  machine started for the same person and the same purpose (`owner` and `onDemand` as the machine
  records them), or from one machine started for nobody to another. Its owner and its lineage's
  stay what they were. A thread whose machine is no longer on record doesn't move: who it is for
  can't be told. Being the platform's service doesn't change this.
- **Nothing left behind.** The move claims the thread in its runtime before anything is made on
  the target, and holds the claim until the thread is placed (`ThreadRuntimes.relocate`). While
  it is held, a send to the thread is refused, and no delivery, turn or session starts. Any
  session of the thread stops first: an idle one, or one only opening for a message waiting on
  the old machine, whose message goes back to the queue. A thread at work doesn't move. The
  thread is placed only if nothing started meanwhile and it is still where it was. Once the claim
  lets go, the queue goes on, on the new machine, so a message sent while the old machine was away
  opens a fresh session there.
- **A machine gone for good.** With `"lost": true` the platform says the machine's compute is
  deleted, not away for a while. A turn still counted as running there (the machine took it with
  it) is ended as interrupted, and the thread moves; what was queued behind it goes on the new
  machine. Without it, a thread at work stays.
- **The answer.** `{ "threadId": "...", "hostId": "...", "moved": true }`. `moved` is false for a
  thread on that machine already. Refusals are as for a start: `409` with `{ "error": "..." }`,
  `400` for a body that isn't the shape, `404` with the hosted features off.
- **Who may call it.** A person signed in through the proxy is refused it, and so is a paired
  phone. Each service call is on the record with the thread, the machine and whether it moved.
  The shapes are `ProfileMoveRequest` and `ProfileMoveResponse`, the path `PROFILE_MOVE_PATH`.

## A workplace of repositories

Each repository is an https or ssh remote with no credential in its address. Gram clones it once
under `profile-repos` in the data folder, with this machine's own git credentials, and fetches it
for each later thread. The thread gets a worktree of it on a new branch: the one the profile
names, else `thread/` and the start of the thread's id. The branch starts from `ref`, which is
the remote's branch of that name as just fetched, else a tag or a commit; without a `ref` it
starts from the remote's default branch. A `ref` the repository doesn't have is refused, never
replaced by the default.

The first repository is the thread's folder and its project. The others are worktrees beside it
that the thread may also work in. The profile's files and skills are laid in the first only:

- A file the repository already has at that path stays as it is. The repository's own wins.
- Nothing is written through a link, so no file lands outside the worktree.
- What was laid is named in an exclude file of that worktree alone, so it shows in no `git status` and an
  agent's commit doesn't carry the supplier's files into the repository's history.

If any repository can't be cloned or can't give a worktree, no thread is started and the
worktrees made so far are removed. The clones stay for the next thread.

## On a headless control plane

A [headless control plane](DOCKER.md#a-headless-control-plane) runs no work itself, so a thread
started from a profile goes on the joined machine that takes whatever names none: the confirmed
machine online now that joined first. With none, the call is refused with the reason and nothing
is made.

- For a workplace of `none` or `scratch`, the machine's host makes the thread's folder under
  `.threads` in the folder it keeps its clones in, and writes the profile's files there. It is
  the one part of the host's own folders a session may open in, as a worker's worktree is.
- For a workplace of repositories, the worktrees are made on the machine from its own clones, as
  a worker's are, and the machine's host lays the files in the first, with the same rules as
  here: never over a file the repository has, never through a link, and kept out of its status.
- The host checks every path and the size of the files itself, whatever the control plane
  checked, and writes only in a thread's own new folder or in a worktree really inside its
  clones.
- A machine whose host is older than this refuses the thread, and says to update it.
- A start that fails takes the folder, or the worktrees, back from the machine.

## What a profile never carries

A profile holds no credential. The model's key is the gateway profile's, named by id. The MCP
server is an address alone, with no user, query or fragment in it and no headers: whatever runs
the session authenticates it to that server some other way.

## Who a supplier is

Whoever may call `thread.createFromProfile` is trusted with the thread it starts. The files it
lays can be an agent's own settings for that folder (`.claude/settings.json`, `.mcp.json`,
`.codex/config.toml`), with hooks and permission rules in them, so the autonomy level and the
charter bind the agent, not the supplier. What stays out of a supplier's hands: a path never
leaves the thread's folder or enters a `.git`, and the MCP hold is applied over whatever those
files say.

On a headless control plane those files land on a joined machine, so a hook a supplier lays runs
as that machine's user, with its git credentials, instead of in the server. The trust is the
same; what it reaches is the machine.

A profile only ever narrows a session. If the thread's role already keeps the profile's server
out, by an allowlist that doesn't name it or a denylist that does, the session opens without it.

## What the thread keeps

The thread keeps the charter, the autonomy level, the MCP server, the fallbacks and the
supplier's `name` and `source` as `Thread.profile`. They are given to every session it opens,
after a restart, a close and a reopen, and to a fork of it. The files are in the folder and
nowhere else.

The thread starts in the mode an orchestrator's workers start in, since nobody is at its
composer.

## Limits

- A thread's folder stays where it was made when the thread is closed: under `profile-threads`
  in the data folder, or under `.threads` in a joined machine's clones.
- A profile names no machine. Only a headless control plane places these threads on a joined
  machine, and always on its default one.
- A thread waiting for its machine shows the first message as queued, not yet in the
  conversation: it is in the transcript once it is sent. A message of another thread, or a
  notice, sent to it while it waits is queued as well.
- Nothing in Gram starts a machine for a waiting thread, or tells whoever does that one is
  wanted: the platform that started the thread knows, and reads `awaitingMachine.failed` from the
  thread if it wants to know that the five minutes ran out.
- A headless control plane still clones a workplace's repositories itself, to read their remote
  and branches, so it needs credentials for them as well as the machine does.
- What a headless control plane can't run yet, a profile can't ask for there: Codex, and a model
  on a gateway profile.
- `fallbacks` are recorded and nothing switches a thread's model by them yet.
- The one MCP server is passed to Claude Code as a remote server of that session and to Codex as
  a server in the thread's own config. Both are covered by tests on synthetic sessions, not by a
  run against a live provider.
- Codex refuses to open a session whose given server has the name of one already in its config,
  the folder's own included, since the two tables would merge and that table's token or command
  would go with the profile's address. Name the server something the machine doesn't use.
- On Codex the hold covers MCP servers. ChatGPT apps and plugins the account has stay as they
  are.
- These threads share one project, whose root holds every such thread's folder. Starting an
  ordinary thread in that project's root would put all of them beneath it.
- When the agent can't open, the thread is handed back in error, as `thread.create` does. Any
  other failure leaves no thread and no folder.
- A joined machine whose host is older than this feature opens the session without the MCP
  server rather than with more than the profile allows.
