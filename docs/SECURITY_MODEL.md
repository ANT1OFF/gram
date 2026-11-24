# Security model

[Up: Documentation map](README.md) · [Security policy](../SECURITY.md) · [Architecture](ARCHITECTURE.md#local-trust-boundaries)

What Gram defends, against whom, and what it leaves to you, so a report or a review can be weighed
against one bar. Defence in depth where it is cheap; not at any cost. Each section links the page
that holds the detail.

## Who is trusted

| Party                                                          | Trusted for                                                                             | Not trusted for                                                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **You**, the person running Gram                               | Everything your OS account can do. Gram runs as you                                     | —                                                                                                                     |
| **Agents** (Claude Code, Codex and the rest), workers included | What their permission mode and your workspace's autonomy let through                    | Approvals, plan requests, consent, settings. Treat their input as possibly hostile: anything they read can steer them |
| **Web pages and other programs' pages**                        | Nothing                                                                                 | The loopback server, the app's IPC, a joined machine's endpoints                                                      |
| **A paired phone**                                             | What you turned on for it                                                               | Machine listing, join, confirm, remove and sign-in endpoints                                                          |
| **A joined machine**                                           | The work placed on it: its worktree, repositories, messages and that thread's app tools | Work not placed on it; Gram's settings and keys; your subscription token unless you send it one                       |
| **A remote machine provider** (a hosted server's machines)     | Running the machines it starts and seeing everything on them                            | Your subscription login; the desktop's other powers; anything beyond what you may do on that server                   |
| **Upstream CLIs, GitHub, model providers**                     | Their own logins and their own sandboxes                                                | — (bugs there belong upstream, see the [security policy](../SECURITY.md#scope))                                       |

**Out of scope:** malware already running as you, a compromised OS, and a person who approves
every ask without reading it. Gram can make each decision legible; it can't make it for you.

## The desktop app

- The renderer is sandboxed and context-isolated with no Node integration. The loopback server
  takes a per-launch boot token and cookie, and checks Host and Origin
  ([HTTP auth](../packages/server/src/http/auth.ts)). Each check is redone at its owner: a disabled
  button or a cached state never stands in for one ([local trust boundaries](ARCHITECTURE.md#local-trust-boundaries)).
- Decisions (approvals, plan requests, consent) are answered only by you, in the app. Messages
  between threads carry their sender and are never shown as yours.
- No telemetry, analytics or crash reporting. Releases are signed and checked before an install
  takes one ([updates](UPDATES.md)).
- Phone access is opt-in, over a tailnet origin you name ([remote access](REMOTE_ACCESS.md)).

## Approvals and autonomy

- **Permission modes are the CLI's own.** Ask, Accept edits, Plan, Auto and Bypass map to each
  agent's own modes ([permission modes](AGENTS_AND_FEATURES.md#permission-modes-by-harness)). In
  Bypass an agent runs as you: your files, your credentials, your network.
- **Autonomy decides what leaves your machine.** Supervised asks before a push, a pull request or a
  merge; Publish before a merge, a close, a release or a workflow; Full asks about none of them
  ([orchestration](AGENTS_AND_FEATURES.md)).
- **The outward gate is a guard, not a sandbox.** It matches the commands it knows. A worker's
  "read-only" brief is an instruction, not a confinement.
- **Ownership.** At Full, an orchestrator merges only a pull request whose head is checked out in
  its worker's worktree; every other case is refused to the agent.

## Subscription credentials

- **Gram never reads your logins.** It reads no Claude Code token, and links Codex's `auth.json`
  by path without reading or copying it. Each CLI keeps and refreshes its own.
- **Isolated per provider and per gateway.** Gateway profiles are opt-in, keep their keys in
  Gram's local vault, and run in homes of their own. A saved key never replaces a subscription
  silently, and a gateway profile's key never leaves this Gram, so such a session doesn't run on
  a joined machine.
- **A token sent to a joined machine is your choice, each time**
  ([a Claude token from this machine](MACHINES.md#a-claude-token-from-this-machine)). It is never
  shown, kept or logged here, is owner-only there, and lasts a year. Deleting it doesn't revoke
  it; revoke it at claude.ai. Its threat model is in the
  [design note](design/machine-setup-token.md#threat-model).

## Helper context consent

Helpers (titles, plans, recaps, suggestions) send your conversation to a model outside the coding
thread, so they need consent of their own
([AI helpers and context consent](AGENTS_AND_FEATURES.md#ai-helpers-and-context-consent)):

- Consent is off by default and separate per provider (Claude, Codex) and per scope (opening
  message, conversation). Gateway consent grants no local permission, and is bound to the exact
  endpoint: editing it voids the consent.
- Claude helpers run with no tools, no MCP, no hooks or plugins and a deny-all permission
  callback. Codex helpers run read-only with no network; residual native tools and ambient CLI
  instructions remain possible, so it is not a full tool-free guarantee.

## Joined machines

[Other machines](MACHINES.md#how-it-is-secured).

- **Guarantees.** A machine joins only with a join code and your confirmation of its key's
  fingerprint. Every dial is signed by its pinned Ed25519 key, within two minutes, with a nonce
  never seen before (kept across restarts). Its endpoints answer only the tailnet name and refuse
  any request with an `Origin`. Removing a machine forgets its key and closes its connection.
- **Does not.** Keep a joined machine from what is placed on it. A machine is trusted with the
  work, repositories and messages of the threads on it, and with those threads' app tools: an
  orchestrator's include starting work elsewhere. Register or join only machines you control
  ([what registering trusts](PROVISIONED_HOSTS.md#what-registering-trusts)).

## Hosted worker machines

A hosted server you sign in to may offer machines for your orchestrators' workers
([design](design/desktop-worker-machines.md#6-trust-boundaries),
[embedding](EMBEDDING.md#workers-own-machines-for-a-desktop-orchestrator)).

- **Guarantees.** Such a machine gets no more than a joined machine, and no subscription token.
  The desktop's calls carry a token narrowed to `machines:workers` and bound to the device key;
  they name no owner, so the server takes the person from the token. The server's answers are
  shown as data, cut to length. A worker runs the model it was given or none.
- **Does not.** Hide the work from the provider: it runs the machine and relays its connection.
  Prove to the provider which orchestrator asks: the provider authenticates the Gram, not a thread
  inside it, so limits it keeps per orchestrator rest on Gram's word.
- **Workers on one machine are not isolated from each other.** When several workers share a
  machine they run as one user, with one home and one process table: each gets its own worktree,
  and can still read what a sibling wrote, including a token a sibling's tool stored. Work that reads what outsiders wrote, or holds a secret of its own, belongs on a machine
  of its own.

## How to judge a finding

Rate who could do it and what they would get:

- **Material.** Something reaches past its party's row in [who is trusted](#who-is-trusted): a page
  or program reaching the loopback server, an agent answering its own approval or consent, a joined
  machine or provider getting a subscription login or work not placed on it, a credential in a log.
- **Known limit.** It stays within a limit stated here: an approved command doing what you
  approved, Bypass acting as you, sibling workers on one machine, a provider seeing what it runs.
  Say which limit covers it.
- **Correctness, not security.** You, or your own Gram and agents, exceeding your own limits, such
  as more workers on your machine than its cap. Fix it when realistic; it isn't a boundary.

Realistic, material findings block a merge. Niche ones go in the pull request as known limits,
one line each. When one class of finding returns round after round, the design has too many
enforcement points: collapse them to one check where the thing happens.

Report a vulnerability privately, as the [security policy](../SECURITY.md) says.
