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
  or `scratch`) on a joined machine. A thread in repositories has work only its machine holds,
  and stays.
- **When it moves.** Only while its machine is away: it is asked before anything is made, and
  again just before the thread moves, so a machine that dials in meanwhile keeps its thread and
  what was made for it on the target is removed. `hostId` must be a joined machine, online now.
- **Whose it stays.** A thread is for the person its machine was started for. It moves only to a
  machine started for the same person and the same purpose (`owner` and `onDemand` as the machine
  records them), or from one machine started for nobody to another. Its owner and its lineage's
  stay what they were. A thread whose machine is no longer on record doesn't move: who it is for
  can't be told. Being the platform's service doesn't change this.
- **Nothing left behind.** A session of the thread's that is idle is put to rest first, so nothing
  follows it should the old machine dial in again. A thread at work doesn't move. A session that is
  only opening, a message waiting for the old machine, follows the move. Whenever its wait ends,
  the thread's machine is read again, and a session that opens on a machine the thread has left
  meanwhile is closed rather than kept.
- **The folder.** Made again on that machine at the path it had, with the profile's files when
  `profile` is given. The thread doesn't keep its files, so the profile is the way to give them.
  What the thread keeps of its profile (`profileBindingOf`) must be what `profile` gives, or
  nothing moves. A machine that keeps thread folders at another path is refused, and what was
  made there is removed.
- **What carries over.** The thread's id, transcript, owner and records stay as they were. Its next
  session opens on the new machine. A session already waiting for the old machine to be started
  (a message sent to it) opens there instead, and the message goes. The agent's own session was on
  the old machine, so the new one starts fresh, as it does when the agent can't find its session.
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
