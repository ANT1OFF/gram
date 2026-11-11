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

| Part         | What it is                                                 | What Gram does with it                                                                                                              |
| ------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `version`    | `1`                                                        | Refuses any other.                                                                                                                  |
| `name`       | The profile's name                                         | The thread's title until it gets one of its own.                                                                                    |
| `source`     | An id and a version, in the supplier's words               | Kept on the thread as given, so the supplier can tell which of its records a thread came from.                                      |
| `agent`      | `claude` or `codex`                                        | The agent the thread runs on.                                                                                                       |
| `charter`    | Standing instructions                                      | Added to the agent's system prompt at every session open, so it outlives a resume and a compaction.                                 |
| `files`      | Text files, each at a path relative to the thread's folder | Written into the folder before the first session opens. `AGENTS.md` goes here.                                                      |
| `skills`     | A name, a description, a body and further files each       | Written where the thread's agent reads a folder's skills: `.claude/skills` for Claude Code, `.agents/skills` for Codex.             |
| `model`      | A model, an effort, a gateway profile's id, fallbacks      | The thread's model. The gateway profile must exist here; its address and key are this Gram's settings. Fallbacks are recorded only. |
| `connectors` | One MCP server by name and address, or none                | Every session of the thread is held to that one server beside Gram's own, or to none, whatever the agent is configured with.        |
| `autonomy`   | `supervised`, `publish` or `full`; `publish` when absent   | The thread's outward gate, as a workspace's autonomy sets a worker's.                                                               |
| `workplace`  | `none`, `scratch`, or one to eight repositories            | `none` and `scratch` get a new folder of the thread's own under the data folder. Repositories are not started yet (see the limits). |
| `input`      | The first message                                          | Sent once the thread exists. Without it the session opens and waits.                                                                |

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

- A workplace of repositories is refused for now, and a thread is made on this machine only.
  Placing one on a joined machine comes with it.
- A thread's folder stays under `profile-threads` in the data folder when the thread is closed.
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
