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
