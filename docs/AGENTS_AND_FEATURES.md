# Agents and features

[Up: Gram](../README.md) · [Architecture](ARCHITECTURE.md)

Gram's primary workflow is your own installed Claude Code or Codex CLI using its
existing subscription login. This guide owns feature and permission distinctions;
[verification](VERIFICATION.md#protocol-native-and-live-checks) covers testing and its limits.

## Overview

A **workspace** is one or more repositories with one orchestrator thread. The orchestrator is an
ordinary Claude Code or Codex session with Gram's coordination tools. It writes a brief for each
piece of work and spawns a **worker** on it; Gram creates the worktree and branch, so your own
checkout stays as it was. Workers report progress, ask questions and open pull requests. The
orchestrator answers what it can, passes the rest to you, and merges once the checks you
configured pass.

- **Adjustable autonomy.** **Supervised** asks before anything leaves your machine (a push, a pull
  request, a merge); **Publish** pushes branches and opens pull requests but asks before merging,
  closing a pull request, releasing or running a workflow; **Full** asks about nothing and lets
  the orchestrator merge and answer its workers' questions. Only you can
  [pause a workspace](#pausing-a-workspace).
- **Hands-off or hands-on.** Every worker is a normal thread: open it to read the transcript,
  send it a message mid-turn, answer its question or stop it.
- **Memory.** Each orchestrator keeps file-based [workspace memory](#workspace-memory) of goals,
  decisions and your standing rulings, which you can edit. An optional
  [Dream](#dream-and-selected-harness-support) run consolidates it into a candidate you review.
- **Messaging.** The orchestrator sends briefs and messages to workers; workers send back reports
  and questions, and can message each other and their orchestrator directly. Below Full autonomy
  each such message asks you first. Messages between threads are labelled with their sender and
  never shown as yours.
- **Models by assignment.** Each workspace lists the models its workers may use, with a note in
  your own words on what each is for, and the orchestrator picks by those notes: for example,
  implementation on Claude, independent reviews on Codex, small chores on a fast model and
  specialised work on a model you choose for it.
- **Questions and approvals.** A worker asks a decision with options and its recommendation, and
  keeps working on what doesn't depend on it. The orchestrator answers only when the brief, a
  standing ruling or its memory settles it; otherwise the question reaches you as written.
  Actions your autonomy level holds back wait on an approval card, and changes to Gram's own
  settings always do.
- **The Board.** A workspace's features, workers and pull requests on one surface, with each pull
  request's checks, reviews and merge readiness, read through the GitHub CLI.
- **Needs you.** Questions, approvals, plans, errors and waits from every workspace and solo
  thread collect in one list; <kbd>⌘⇧U</kbd> steps through them.
- **Usage limits.** The Usage page shows Claude and Codex five-hour and weekly limits (see
  [accounts, models and speed](#accounts-models-and-speed)). A workspace can pause new workers
  near a limit, hold low-priority briefs until it resets and, if you turn it on,
  [offer another model](#offering-another-worker-model-at-a-limit).
- **Everything else.** Solo threads outside any workspace, a terminal, a diff view, a browser
  preview agents can drive with your approval, local dictation and optional AI helpers, each off
  until you turn it on.

### Events instead of polling

Agents don't sleep in loops or poll GitHub. Gram watches pull requests through `gh` and turns
changes into events that wake the thread that cares:

- **Monitors.** `pr_monitor` watches a pull request's checks, `pr_review_monitor` its review bot
  and reviewers, and `run_monitor` a GitHub Actions run such as a release build. Each sends one
  message when the checks settle, the bot posts a round or a verdict, a person approves or
  requests changes, the merge state changes, or the run completes.
- **Wakes.** `schedule_wake` wakes a thread at a time, or on the first of a set of pull request
  events: checks settling, a review bot's verdict on its head, a new push, a merge or a close.
  `depends_on` wakes a thread whenever the pull request it depends on merges, closes or gets a
  new push.
- **Merges.** `merge_when_ready` waits for the workspace's merge review policy, required checks or
  a passing [local merge check](#project-local-merge-checks), and GitHub's rules, then merges
  pinned to the head it checked.
- **Digests.** Worker reports, finished turns, errors, long-open requests and pull request changes
  wake the orchestrator with one digest built from the current ledger.

## Accounts, models and speed

Codex and Claude Code are the only executable harnesses. Select one when starting a thread. Signed-out agents remain selectable and
explain login/retry. New defaults come from CLI discovery; an explicit saved model,
effort, speed or gateway profile remains authoritative. **Retry models** and
**Re-check** refresh discovery after login changes without interrupting held Codex
sessions. Codex checks account status and follows all model pages; known sign-out
errors withdraw stale listings. Diagnostics distinguishes ChatGPT login, API-key
billing, signed-out and unknown status. A listing or support check is not account
entitlement, remaining quota or proof that a turn will succeed.

Subscription limits come from CLI-owned account queries at startup and about every
minute while idle, with refresh from the Usage page. Claude Code supplies structured
`/usage` data; Codex supplies `account/rateLimits/read`. Turn events update the same
kept readings between polls. Usage cards, the title bar and overview sidebar use
the same five-hour and weekly windows, with 24-hour reset times. A successful
sign-out or unavailable response removes that provider's readings; temporary query
failures retain the last observation and its age. Gateway limits stay separate.

Standard/Fast speed is separate from reasoning effort. New choices default to
Standard; Fast is offered only with CLI/model support. Claude Fast is separately
billed outside included Pro/Max usage; Codex Fast uses more allowance/credits.
API-key sessions follow API billing. Gram preserves provider availability checks.

Gateways are opt-in URL/key profiles, selected explicitly. Saved keys or gateway
defaults never silently replace a local subscription. Gateway children keep their
credential homes isolated; local CLI authentication is not copied into them.
Gateway keys stay in Gram's local vault; subscription credentials stay isolated per provider.
Manual MCP configuration and each agent's own sign-in remain available. Restricted
Codex sessions disable plugin/apps loading and refuse excluded MCP servers that
remain enabled, while preserving the configured built-in search policy.

Settings → Gateways can explicitly import URL/model profiles from OpenCode or
Codex configuration. OpenCode key import remains a separate consent-based action
for the matching endpoint; no OpenCode executable is invoked. Gram does not scan,
import or select gateway profiles on startup. An import never changes a thread's
subscription choice or grants helper-context consent.

Source: [Claude adapter](../packages/agents/src/claude/index.ts),
[Codex adapter](../packages/agents/src/codex/index.ts),
[gateway credentials](../packages/server/src/gateway/credentials.ts).

## Orchestration context

Digests count archived groups without listing their names. `list_workers` omits
archived workers, groups and their stage notes by default, including with
`detail: true`. Use `includeArchived: true` (or `state: ["archived"]`) to inspect
that history. Current questions, failures, blockers and PR changes stay visible.

Workers may add `evidence: { headSha, gate, pr?, nextStep }` to `report`. These
bounded, worker-authored claims appear in full before the prose excerpt and in
compact ledger rows; they do not qualify a server merge gate. The SHA accepts
7–64 hexadecimal characters, gate text up to 160 characters, PR text up to 200,
and next step up to 240. Evidence is optional.

A worker that yields to an armed PR monitor, merge intent, workflow-run monitor
or scheduled wake is deliberately waiting. It does not get an unreported-stop
flag; foreground tools that stall and actual failures still surface.

Advisory changed-file overlap exclusions are workspace-specific:
`OrchestratorCharter.overlapIgnorePaths`, accepted by `orchestrator.setCharter`,
is a replacement list of exact repository-relative paths or basenames matched at
any depth. Omit it for the neutral lockfile defaults; use `[]` to exclude nothing.
For example, `["package.json", "config/tests.ts"]` excludes those paths and
re-enables lockfile overlap advice. This affects advisory overlap only, not Git
conflict detection, file counts or merge checks. Configure each workspace to suit
its repositories; no project-specific files are excluded by default.

## App-tool approval results

Supervised and Publish workspaces can run Codex orchestrators and workers on your
ChatGPT login. Gram prepares `codex-owned-home` under its data directory, with
`auth.json` symlinked to your CLI's `$CODEX_HOME/auth.json` (or `~/.codex/auth.json`).
Gram never reads or copies that file; the CLI owns login and token refresh. A login
stored only in a keyring, a missing file or a failed symlink/preparation refuses
this route. Run `codex login` with file-based credential storage and retry.

This home carries selected model preferences, MCP configuration and skill settings
from your config, with private file permissions. Provider/profile, permission,
project-trust, hook and plugin settings and user rules are excluded. Native gated
threads use the ChatGPT provider, file auth and Gram's approval policy. Gateway
profiles keep their separate home and credentials. Plain native chats keep using
your own CLI home.

Before a gated thread starts, resumes or forks, Gram installs prompt rules in its
owned home. These outrank existing allow rules, including repo `.codex/rules`.
Gram's command matcher then raises a once-only card for the outward commands the
workspace's autonomy asks about; approving one never creates an allow rule.
Supervised asks before ordinary pushes; Publish permits them but still asks
before force pushes, merges and other irreversible commands. Modes that cannot
ask remain refused. This is an accident gate over recognized command spellings,
not protection against arbitrary scripts or a hostile agent.

Sessions stay in the home where their provider history was created. A plain session
in your own Codex home cannot be resumed under the gate: start a fresh gated session
instead. Preparation and mode checks run before admission,
and preparation/rule installation failures still stop thread startup.

Gram's app-tool approvals are separate from a CLI's native permissions. Full Auto
waives an own-worker merge card only after verifying the held workspace worktree
and branch; following a PR or checkout grants no ownership. Explicitly name a
follow-on PR when the thread still binds an older main PR. Root pauses, user/worker
holds, scoped approval provenance and current-head merge checks remain authoritative.

A pending app-tool approval is cancelled when its turn or session ends, Stop runs,
or the runtime's retry deadline expires. This denies execution without asserting
that the user rejected it. A user-decline result requires an explicit approval
response. Unknown denial provenance stays unknown. MCP refusals can carry bounded
server-owned resolution metadata, and diagnostics record request/resolve IDs and
origin/reason without prompt or card bodies. A generic decline alone cannot
establish a user decision.

Diagnostic lookup/logging is best effort and cannot hold a captured approval waiter.
Receipt permission mode is a request-creation snapshot. An app card left stored by
failed withdrawal keeps its server-owned response route; late answers are refused
until successful cleanup. These origin markers are transient. On restart, mandatory
stale-request cleanup either removes old cards or refuses runtime startup. Native
approval routing resumes for genuine new cards after successful cleanup. Captured
withdrawal and decision completion are protected from interruption; subsequent
status restoration, queued delivery and provider I/O remain cancellable. Cancelling
that later work preserves the completed approval decision and releases the lock.

Orchestrators and plain threads can change Gram's settings by chat with
`settings_propose`. Every change waits for the user's own approval on a card in the
thread, which shows each setting before → after. That card is raised at every
autonomy level, `full` included, and in every permission mode. Workers can read
settings with `settings_read`, but they can't propose changes. Pausing and resuming,
default permission modes, connectors, credentials, gateways, folders and consent
switches are refused even with approval.

They can also set up workspaces by chat. `workspace_list` shows the workspaces with
their projects and settings. `workspace_create` proposes a new workspace: its name,
its projects by absolute path, the home project, autonomy, worker mode and charter
settings. `workspace_update` proposes adding or removing projects, another home, a
new name, autonomy, worker mode or charter settings. Each project path must be an
existing git repository's top folder, named by its real path: a path through a link
is refused, with the real folder to use instead. One Gram doesn't know yet is
registered as a project when the user approves. The approval grants that folder,
whatever it holds later. Each call shows the user one card with the whole
workspace, or the whole change before → after, and nothing changes until they approve
it. An approved change is applied whole or not at all: if the workspace changed, or a new
folder stopped being a repository, while the card waited, nothing changes. These cards are never answered by Full Auto, Bypass
or an earlier approval. An orchestrator may propose changes only to its own
workspace; workers get none of these tools. See
[settings by chat](design/settings-by-chat.md).

## Orchestration tool inputs

Use `message` for cross-thread messages (`send_message`, `message_orchestrator`,
`broadcast_message`), `file` for a memory file, and `content` for memory writes,
appends and the body of `wait_on_user`. `text`, `path` and `body` are accepted as
aliases; message tools also accept `content`, and memory writes/appends accept
`text` or `message`. `set_thread_effort` uses `effort`, with `variant` as an alias.
Domain fields such as `brief`, `question`, `answer`, `summary`, `note`, `copy`,
`old` and `new` keep their distinct meanings. Different values supplied through
aliases are refused before approval or execution. Results name memory files `path`.

Report `evidence {headSha, gate, pr, nextStep}`, `list_workers.includeArchived`
(which covers archived groups too) and the charter's `overlapIgnorePaths` are
exceptions to the message/file/content convention and have no aliases.

Tool schemas expose existing character and item limits. A length refusal names
the field (including a nested option), its limit and the actual length. Filesystem
byte caps, combined memory size and current-state limits still apply at execution;
a string's character count alone cannot express those constraints.

Clear a merge hold with `merge_when_ready({hold: null})`; empty or whitespace-only
holds also clear it. The result includes `hold: null` and `note: "no hold"`.
Clearing only the hold keeps PR dependencies; the existing `release: true` also
releases the intent's explicit `after` list. A worker cannot clear its
orchestrator's hold through any spelling.

`manage_held_spawn` accepts the `held-…` brief `id` returned by `spawn_worker`,
with `action: "cancel"` or `action: "retarget"` and a configured worker `model`.
Only its current owning orchestrator can act. Cancellation removes the pending
brief. Retargeting keeps its brief, plan and retry identity, rechecks provider
limits and starts through ordinary admission when limits, slots and user pauses
allow. `stop_thread` and `set_thread_model` operate on threads that have started.

### Worker brief footer

A workspace may keep a **worker brief footer** (Settings → Workspaces → the workspace →
Models). It is empty by default. When set, Gram appends it to every worker brief spawned in that
workspace, including a worker the user starts directly, after a `---` line saying it is the
workspace's standing instructions set by the user. The user's own words attached with
`userMessages` still come last, under their own line. The orchestrator's charter quotes the
footer and tells it not to repeat it, and an open session is told in its next digest when the
footer changes. Settings by chat can set it with the usual approval card.

### Offering another worker model at a limit

The workspace setting **Offer another model** (`routeAtLimit`) is off by default. While it is off,
nothing changes. When it is on, Gram still never swaps a model on its own. It never reads a meter
percentage either: it follows what actually stops a spawn.

- **A spawn whose account is at its limit.** The CLI refused turns on it. A share, even a full
  window, never counts, since credits can carry on past it. Nothing
  is spawned. `spawn_worker` returns `routeOffer: true` with the roster's other models that are
  clear of the limit, each with the user's note (`alternatives`). The orchestrator calls again
  with the `model` whose note fits the brief, or with `atLimit: "stay"` to go ahead as before.
- **A brief the hold gate held.** The `held` result also carries `alternatives`, so the
  orchestrator can move it with `manage_held_spawn` `retarget`.
- **A spawn the pause gate refused.** The refusal becomes a route offer. It stands as a refusal
  when no model is clear.

A model counts as clear when it runs through a gateway profile, or when its agent's login is
neither at its limit nor paused by the user. Other models on the same login are never offered,
because they share its limit. The orchestrator is told to respect notes that rule work out, such
as "never UI". A spawn that goes ahead returns `model`, the model the worker runs on. What makes
the hold and pause gates fire is owned by the limit-wait work, not by this setting.

## Project local merge checks

A solo workspace can use a local check for each project. It is **off by default**:
with neither profile nor command, `merge_when_ready` uses its other policies, including CI and GitHub
rules. Its result, `pr_status`, merge notice and workspace ledger explicitly say
“no local check configured for <project>” and “local gate OFF”; this is not a passed
check.

Read the current project's settings with `settings_read`. Ask the orchestrator or
a plain thread to propose these keys through `settings_propose`; the user must
approve the before → after card every time, including in Full Auto:

| Key                            | Value                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `project.localCheck.command`   | Shell command to check the merged source, for example `make test`; unset, blank or `null` disables it.                              |
| `project.localCheck.setup`     | Optional setup command, for example `make deps`; `null` clears it. Setup must succeed before the check runs.                        |
| `project.localCheck.timeoutMs` | Whole milliseconds for setup and check together, from 1 to 86,400,000; default 5,400,000 (90 minutes). `null` restores the default. |

Omit `projectId` to select the thread's project, or name a project in the thread's
workspace by id or name. A proposal changes one project, one workspace, or app
settings separately. Workers can read the settings but cannot propose them. There
is no settings UI field yet. Commands are single lines of at most 16,384 characters;
control and invisible formatting characters are refused. Keep longer or multiline
workflows in a repository script.

The approved commands execute repository code on your machine, under `/bin/sh`,
with the user's resolved login-shell PATH. Gram first creates an isolated checkout
of the exact PR head merged onto the exact current base. Setup and check run in
that checkout as separate process invocations; setup must exit zero before the check
starts, and the check must also exit zero. Environment exports from setup do not
carry to the check. Both share one timeout, and their output is kept in the same log. Put toolchain/version checks in your own command when
needed. A failed command, timeout or merge conflict blocks local qualification.
Changing the command, setup or timeout invalidates previous passes. Head/base pins,
GitHub restrictions, review policy, holds, ownership and pauses still apply.

The complete stored configuration is pinned through the write/audit transaction;
a stale approval writes neither. An unreadable stored gate remains unavailable
local evidence, with a repair card describing its complete replacement and
effective timeout; private malformed contents stay hidden. Qualifying GitHub CI is
the alternative under the merge policy.

### How the gate runs

`merge_when_ready` runs the check when a passing check is all a merge lacks; `local_check` starts
it early for a worker's own bound PR. Gram fetches the pinned head and base into its own bare
repository (hashing objects again and ignoring agent-writable config, attributes, hooks,
replace refs and grafts), merges them and creates a fresh checkout with an unpredictable name.
A stored pass is specific to the project, command, setup, timeout, exact head and base, and
merged tree: a moved base invalidates it even when the merged tree is identical.

Gram's own merges onto one base branch of one repository launch one at a time, across threads
and workspaces. Each reads GitHub afresh, compares the base its check ran on and launches under
that branch's lock. After a merge, every other armed `merge_when_ready` in the repository looks
again, and a pass on the old base runs again on the new one. The lock fences only Gram: a push or
merge by anyone else in between is for GitHub to refuse, with a branch rule requiring pull
requests to be up to date, or a merge queue.

A check under way when Gram quits keeps running under a wrapper that leads its process group,
writes the exit status beside the worktree and stops the group 30 s past the timeout. On the next
start a check whose process is verifiably the same is followed to its end, and one that ended
while Gram was closed keeps the status it wrote; both read **kept running while Gram was
closed**. A check whose process is gone with no status runs again once from the start and reads
**restarted after Gram quit**; a second cut-off fails with that reason.

Gram runs one local check at a time on a machine by default, or two with 12 or more cores;
`workspaces.localCheckConcurrency` (Local checks at once) changes it. Waiting checks read
**queued for local check (n ahead)**, and a check's timeout starts only once it runs. A sweep
five minutes after start and every six hours forgets finished checks (passes after 30 days,
everything else after 7), keeps the logs within 256 MiB and reclaims only work folders with
Gram's own name that no running check uses.

Failures keep missing-command and PATH diagnostics, the timeout, signal, exit or conflict
classification and a redacted output tail. The check runs the PR's own scripts, as CI does, so
a change that weakens a test is the reviewer's to catch. The result is the user's own, not a
GitHub status.

## Workspace memory

An orchestrator's new workspace starts with only `MEMORY.md`, a seeded index with
suggested topic names. Files such as `goals.md`, `decisions.md` and
`standing-decisions.md` are created when there is something to record.
`memory_list` reports actual files; `memory_read` returns a missing-file error for
an unwritten topic. Suggested names do not establish recorded goals or decisions.
The orchestrator should record actual information and update its index as it goes.

Memory persists in a versioned filesystem tree, with `CURRENT` naming the adopted
version; opening another session preserves existing files. Startup explains the
sparse layout. It carries recorded standing decisions when
present and warns when they cannot be read for reasons other than absence.

## Pausing a workspace

Only the user pauses or resumes a workspace (title bar, Board, sidebar, palette); no
agent tool can. The user's pause stops the orchestrator and every live worker without
interrupting anything: Claude Code refuses every further tool call, Codex is asked to
end its turn, and each agent ends its turn itself once the step it is on finishes. So
a pause takes effect at the end of the current tool call or turn, and the UI says
"Pausing… finishing the current step" meanwhile. A card waiting on the user stays
theirs, and sessions keep their conversation. Workers the user holds keep their turn. While paused, queued messages, wakes, PR and run monitor notices and
digests are held; a held notice is replaced by its newer one. `merge_when_ready`
intents stay armed and merge nothing; a merge already launching finishes first. No
worker is spawned. Resume sends the
orchestrator one digest covering the pause, then lets workers go in batches of three,
45 seconds apart, those it stopped told to continue where they left off. Pauses the
server makes (delivery failure, parking, re-enabling) stop only the orchestrator.

## Idle compaction

A large Claude thread left idle is compacted with its own `/compact` just before its one-hour
prompt cache expires, so the next wake starts from a summary instead of writing the whole
conversation into the cache again. It is on by default for each workspace's orchestrator;
Settings → Workspaces (`idleAutoCompact`, `idleAutoCompactKinds`) turns it off or adds workers,
and settings by chat can change both with the usual approval card.

- **Which threads.** Claude only, with at least 150K tokens of context, when the last turn's
  cache writes were all one-hour writes. Codex reports no cache lifetime, so it never qualifies.
- **When.** 55 minutes after the start of the thread's last request, and at least 10 minutes
  after its turn ended. It must start within 59 minutes of that request; past that it is
  skipped.
- **What holds it.** Typing in any composer in the last two minutes, a draft for the thread, a
  window whose draft reports are 75 seconds stale, a thread that isn't wholly at rest
  (background tasks, subagents, waits), a paused workspace or feature, a worker the user holds,
  or an open worker question. A held compaction looks again every 30 seconds until its deadline.
- **Afterwards.** The transcript shows Gram's request and a marker with the outcome and a link
  to the setting. A compaction that didn't complete is retried only after the context has grown
  by a tenth. After an orchestrator's compaction, its next digest carries its boot context again.

Source: [idle compaction](../packages/server/src/orchestration/idle-compact.ts),
[composer presence](../packages/server/src/runtime/composer-presence.ts).

## AI helpers and context consent

Helpers generate titles, plans, recaps and suggestions independently of coding
threads. New settings choose local Automatic. Opening-message and
conversation consent are separate for Claude/Anthropic and Codex/OpenAI and start
off. Existing gateway consent grants no local permission. Automatic prefers
**discovered** Haiku 5.5, then discovered GPT-6 Luna; explicit saved choices win,
and an unlisted model stops. High effort is used only when listed. Authentication,
restriction or consent failures stop; no local policy implicitly routes to a gateway.

The coding agent can write its own end-of-turn recap with the `wrap_up` app tool
(plain threads and workers). It is a data part on the turn's reply, so it needs no
helper, model call or helper consent. The card under the transcript shows it when
the turn ends: a recap, plus one question and up to two buttons only when the next
move is the user's. A button is a reply sent as the user's message, or Push, Create
PR or merge. These open the thread's own controls, and Gram checks they have work
to do. For that turn `thread.recap` serves the agent's recap and skips the helper.
Turns without one keep the helper recap when the helper is on. The helper's recap
setting governs only helper recaps; the agent's box is part of its transcript.
Only the main agent calls it: Claude's session denies a subagent's call. Plain Codex
threads and Codex workers are told its name, since Codex hides MCP tools behind its
tool search.

Claude helpers use an isolated one-shot SDK query: no tools, strict empty MCP,
empty setting sources, disabled hooks/plugins, no persisted history, Standard
speed and a deny permission callback. Context waits for restriction verification.

Codex helpers use the guided adapter qualified for **CLI 0.162.1**. It uses
separate ephemeral threads, disables environment tools, requests read-only/no-network
permissions and forbids escalation. The child pins and verifies the built-in
ChatGPT inference route before delivering context, overriding inherited custom
endpoints only for that helper child. Other/unknown versions refuse with setup
advice. Residual native tools and ambient CLI host instructions/skills remain
possible: guided is not a complete tool-free or snapshot-only guarantee.

Gateway helpers require explicit helper-source selection and consent bound to the
exact endpoint; editing the endpoint invalidates consent. Subscription access
never pays for gateway requests. Token-dollar estimates are historical, not the
provider's bill or a reliable billing cap. A region-like model suffix provides no
data classification guarantee. Set spending limits at the provider.

Source: [helper settings/model policy](../packages/contracts/src/helper.ts),
[local scheduler transport](../packages/server/src/helper/local.ts),
[Claude helper](../packages/agents/src/claude/helper.ts),
[Codex helper policy](../packages/agents/src/codex/helper-policy.ts).

## Dream and selected-harness support

Dream prepares a candidate. Review is the default; per-run Auto adopts only validated,
bounded memory output and preserves native permissions. It is a separate
transport and permission decision from helper generation and ordinary coding.
Claude Code supports bounded file-tool Dream on macOS/Linux with
`/usr/bin/python3`: snapshot inputs read-only, candidate/notes writable, native
tools disabled.

Codex Dream is guided at CLI 0.162.1: workspace-write sandbox and on-request
approvals, with instructions guiding snapshot reads and candidate writes. Native
tools can access other permitted files. Gram validates candidates before Review/Adopt or per-run Auto applies them. Complete file-only native-tool confinement is unavailable;
strict file-only policy refuses this route. Other/unknown installed Codex versions
remain unqualified for Dream while ordinary sessions stay available.

Selected-harness preflight reads discovery, model/profile and support before
startup. It does not run a provider turn, open a page or grant permissions.
Admission revalidates startup inputs; stale roster/membership changes require retry.
Source: [Dream support](../packages/agents/src/dream-support.ts),
[support service](../packages/server/src/agent-support/service.ts),
[Dream service](../packages/server/src/orchestration/dreams.ts).

Automatic Dream is off by default. Each workspace's settings page (Settings → Workspaces,
then Advanced) can start Dream after 1–1000 distinct completed worker or conversation threads (initial
editable value 10). Completion means an agent/user completion mark or a merged PR;
a reply ending or becoming idle does not count. Dream/orchestrator threads and helper
jobs do not contribute. Ordinary conversations follow the workspace's project inputs;
workers belong to their owning workspace.

Enabling or editing the threshold starts a fresh count without historical catch-up.
Successful manual and automatic starts reset progress; failed or cancelled runs need
fresh completed threads. Seen IDs survive restart and reopening while their live,
closed or archived history is retained. A restart preserves recorded progress but does
not count missed completions or replay a launch. Pauses, user holds, running Dreams and
unavailable selected models defer launch. Relevant external activity or settings changes
recheck a deferred launch; no UI timer runs it. Progress and deferral appear beside the
setting. Automatic launches always use Review; they grant no global adoption authority.
Scheduling uses one Dream service's start lock, with a durable claim before launch;
exclusive coordination across independent server processes is not established.
Source: [scheduler](../packages/server/src/orchestration/automatic-dream.ts).

## Codex ownership and reopening

The provider-thread fence outlives Gram listeners and discovery-server retirement.
At pinned 0.162.1, `thread/closed` or unsubscribe acknowledgement cannot establish
recorder/writer release. Only observed **owning-child exit** clears the fence.
After closing the final Gram scope, both replacement-child resume and same cached
child reopen refuse while that owner lives, including normal closed-thread reopen.
Held sibling sessions are preserved; Gram does not kill them to clear the fence.
Multiple scopes on the same exact child/auth identity are counted. An unsettled
open conservatively requires owner exit too. This is not an OS-wide ownership lock
across independent server layers or Gram processes.

Source: [thread ownership](../packages/agents/src/codex/thread-ownership.ts).
See [verification](VERIFICATION.md#protocol-native-and-live-checks) for synthetic and live lifecycle checks.

## Worktree storage and cleanup

Settings → Storage lists every known repo's linked worktrees in five groups: in
use (an open thread holds it), idle, removable (PR merged or closed, or HEAD in
the base branch, with nothing uncommitted or unpushed), kept (uncommitted or
unpushed work, or locked) and not made by Gram (outside `<repo>/.worktrees/`).
"Clean up inactive" computes its list and size first, then asks once; unknown
activity never counts as inactive. Branches are always kept, so a thread's restore
can bring a worktree back. A worktree with work at risk, or one Gram didn't make,
is removed only after a confirmation naming it, and is kept if more work appeared
than that confirmation showed. Right before each removal the server reads the
threads and git again; a locked worktree is never removed. The foreign group's
prune only runs `git worktree prune` for registrations whose folder is gone.

The sweep is on unless turned off and covers every thread kind except
orchestrators; workers only while workspaces are on, and other threads only in
`<repo>/.worktrees/`. A merged thread's clean,
pushed worktree is removed about ten minutes after the merge; otherwise the free
and remove day counts apply. The close dialog pre-ticks removal for a clean,
pushed worktree. Each cleanup tells affected workspaces one quiet digest line
(`Cleaned 3 worktrees, 1.2 GB.`), carried by the next digest without waking the
orchestrator.

Source: [storage](../packages/server/src/git/storage.ts),
[sweep](../packages/server/src/git/worktree-gc.ts),
[Storage page](../apps/web/src/settings/storage-page.tsx).

## Browser, notifications and dictation

Browser Preview/support observations are passive; inspection and capture use
explicit app tools. Access, host/action approval and document freshness checks
remain authoritative at dispatch and delivery. Missing metadata is unavailable;
a failed read is unknown and may be retried read-only. Neither observation grants
browser capability. Native page access keeps private-network, sign-in, credential and
per-host restrictions.

Agents drive their Preview page with `browser_*` tools: navigate, snapshot (with an
interactive filter, depth, ref subtree and character limit), find, text, scaled
screenshots, click (double/right), type, form input, any key with modifiers and a
repeat, hover, wheel scroll and scroll-to-ref, drag, bounded waits, and viewport
size, colour-scheme and phone emulation. `browser_batch` runs up to 20 of them in
order, stopping at the first failure and after any step that asked the user.
Every input keeps user takeover, per-host approval, the per-submission card,
held public writes and the worker loopback limit; a key that may submit a public
form is asked about and pressed once.

On local pages only, `browser_evaluate` runs an expression in the page and
`browser_network` lists its requests and reads their bodies; both are refused on
public pages. `browser_save_screenshot` (PNG) and `browser_record` (GIF) write
evidence inside the thread's own folder only. Input tools take an `actionSummary`
the Preview header and transcript show. `preview_start`, `preview_list`,
`preview_stop` and `preview_logs` run a project's dev servers by name from
`.gram/launch.json` (or `.claude/launch.json`): each start names the exact command
on a card first, takes the next free port, and stops with its thread.

Notifications retain sanitized history and quiet startup diagnostics; saved
notifications omit sensitive runtime details. Dictation runs locally with NVIDIA
Nemotron through sherpa-onnx, after explicit verified-download/license consent and
microphone permission, and inserts draft text only. English is supported. Native loading does not prove
microphone or recognition quality; see [verification](VERIFICATION.md#manual-provider-and-dictation-checks).

Source: [browser bridge](../packages/server/src/browser),
[notifications](../apps/web/src/stores/notifications.ts),
[speech module](../packages/shell/src/modules/speech).
