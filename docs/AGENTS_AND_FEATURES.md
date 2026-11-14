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
- **Discover.** A new workspace starts by discovering itself, and **Discover workspace** in the
  title bar's Workspace menu or the palette runs it again. It sends the orchestrator a message, as
  Tidy up does: one worker, briefed to only read, surveys each repo (what it does, how it builds
  and tests, open pull requests, failing CI on the default branch, open issues and branches with
  no pull request and no commit in 30 days). The orchestrator records what it found in a
  `repo.md` memory topic and asks one question with up to four starter tasks, each tied to a
  finding, to tick. It starts only what you pick, at every autonomy level. The worker's
  read-only limit is its brief, not a sandbox: in Supervised and Publish, anything it tried to
  push or open would still ask you first.
- **Memory.** Each orchestrator keeps file-based [workspace memory](#workspace-memory) of goals,
  decisions and your standing rulings, which you can edit. An optional
  [memory update](#memory-updates-and-selected-harness-support) run consolidates it into a candidate you review.
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
  settings always do. The call's tool row reads "Waiting for your approval" until you answer,
  and its card sits right under that row; a card whose row isn't in view waits above the composer.
  While a turn only waits on you, Stop steps back to an outline and the card's answer is the
  primary step.
  **Allow once** saves nothing; **Always allow…** first shows the exact rule the agent offered
  and its widest reach as Claude Code applies it: this thread's session, the repository with all
  its worktrees (`.claude/settings.local.json` at the repository root), the project's shared
  settings, or every project on the machine. It saves only on a separate confirming press, and a
  held key never answers a second card. Codex cards offer no "always", as they carry no rule.
- **The Board.** A workspace's features, workers and pull requests on one surface, with each pull
  request's checks, reviews and merge readiness, read through the GitHub CLI.
- **Inbox.** Questions, approvals, plans, review requests, drafts, errors and steps from every
  workspace and solo thread collect in one list by kind, each answered in a pane beside it. Each
  row is two lines: what the item is about, wrapping before it is cut, then its workspace, its kind
  where the heading doesn't say it, its thread and age; its hover says the whole of it, and the
  whole question and its choices are in the pane. An approval's verbs take the keys its card in the
  thread does: <kbd>1</kbd> Allow once, <kbd>2</kbd> Always allow this rule…, <kbd>3</kbd> Deny. The Inbox opens
  as a dialog over the work, the same in Quiet and out of it and at every window size, and
  <kbd>⏎</kbd> or Open thread closes it and opens the item's thread at the turn that asked. The
  title bar's Inbox button, the sidebar's pill and <kbd>⌘⇧I</kbd> open it where it was left;
  <kbd>⌘⇧I</kbd> again or <kbd>Esc</kbd> closes it. <kbd>⌘⇧U</kbd> steps through its items at
  the turn that asked. Under each item the pane shows the asking thread's
  last few turns and what its edits changed. An answer can be taken back for a few seconds from
  one receipt: the Inbox's foot while it is open, above the orchestrator's composer after. The
  thread that asks keeps its own card too.
- **Usage limits.** The title bar's meter shows the highest usage of any provider's window
  (its hover names which), neutral until 90% so amber stays for what needs you. Its popover's
  Open Usage goes to Settings → Usage: Claude and Codex five-hour and weekly limits with their
  pace against an even spread, Codex credits and what they burn, and 7- or 30-day history (see
  [accounts, models and speed](#accounts-models-and-speed)). Tokens by day, model, workspace and
  thread stay on the Usage page. A workspace can pause new workers
  near a limit, hold low-priority briefs until it resets and, if you turn it on,
  [offer another model](#offering-another-worker-model-at-a-limit).
- **History.** Finished workers, done and archived threads and past CLI sessions in one
  searchable list (<kbd>⌘⇧H</kbd>). It is old work's one home: the sidebar's Done shows the three
  latest and hands the rest to History's Done chip, and a palette search that matches finished
  threads offers them there rather than beside the live ones. A solo thread settles into History
  on its own once its pull request merged, or after it has sat idle for the days set in Settings
  → General → Settle idle threads (7 by default; Never keeps it). Pinned, unread and waiting
  threads stay, and new activity brings a thread back. Mark unread on a row keeps a thread in
  view to come back to.
- **Snooze.** A solo row's Come back later and the palette (from anywhere, or a header's "…" →
  More…) snooze a thread for
  an hour, until 18:00, until 09:00 tomorrow, until Monday 09:00 or until a time you pick. It
  leaves the lists (a solo thread under a folded Snoozed line) and its header says "Snoozed until
  Fri 09:00" beside Unsnooze. It comes back unread at that time, or sooner when it asks you
  something, needs an approval or fails. The server keeps the snooze on the thread and times it
  with the wakes, so it survives a restart and one due while the app was closed ends at start.
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
- **Wakes.** `schedule_wake` wakes a thread at a time, on the first of a set of pull request
  events (checks settling, a review bot's verdict on its head, a new push, a merge or a close), or
  on a [condition](#condition-wakes) such as a branch getting a new head or another thread
  finishing. `depends_on` wakes a thread whenever the pull request it depends on merges, closes or
  gets a new push.
- **Merges.** `merge_when_ready` waits for the workspace's merge review policy, required checks or
  a passing [local merge check](#project-local-merge-checks), and GitHub's rules, then merges
  pinned to the head it checked.
- **Digests.** Worker reports, finished turns, errors, long-open requests and pull request changes
  wake the orchestrator with one digest built from the current ledger.
- **Routines.** A workspace's [routines](#routines) start a fresh worker (or brief the orchestrator)
  on a schedule: every day, every weekday or once a week at a time you set, or every few hours.

### Condition wakes

`schedule_wake` takes a `condition` from a closed union of kinds, instead of `onPr`:

| Kind               | Input                                                                                                 | Fires when                                                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branchMoved`      | `repo`, optional `branch`                                                                             | the branch (the repo's default branch when none is named) gets a new head, or is deleted                                                                                                                                                                         |
| `threadFinished`   | `threadId` of another thread                                                                          | it reports done, is marked completed, or is at rest after a report; or it is archived or closed, which also ends the wait                                                                                                                                        |
| `ciStuck`          | `repo`, optional `pr` or `runId`, `queuedMinutes`                                                     | a hosted job of the PR (the thread's bound PR by default) or of the run sits queued with no runner for `queuedMinutes` (15 by default), or a run waits for a maintainer's approval, as a fork's does                                                             |
| `machine`          | `metric: "load"`, `below`, optional `forMinutes`; or `metric: "diskFree"`, `belowGB`, optional `path` | this machine's 1-minute load average, absolute as `uptime` shows it, stays below `below` for `forMinutes` (5 by default); or free space on the volume holding `path` (the thread's repo by default) drops below `belowGB`, in GB of 10^9 bytes                   |
| `freezeLifted`     | `repo`, optional `branch`                                                                             | a [merge freeze](#merge-freezes) on it is lifted or expires                                                                                                                                                                                                      |
| `releasePublished` | `source` (`npm` or `github`), `name`, optional `after`, `minAgeDays`, `includePrerelease`             | the package or repo publishes a version newer than `after` (the latest when the wake is set, by default) that is at least `minAgeDays` old (7 by default, as Gram's Dependabot waits; 0 for none); prereleases and drafts don't count unless `includePrerelease` |
| `versionChanged`   | `target` (`gram`, `claude`, `codex` or `gh`), optional `from`                                         | the installed version changes from `from` (the installed one when the wake is set, by default): Gram's at the start after an update, a CLI's when Gram's launch checks next run                                                                                  |

The tool lists `condition` to a session as one flat object (`WakeConditionInput`): every kind's
fields, each optional but `kind`. The union spelled out cost over twice as much, read at every
session's start. `schedule_wake`'s description says which fields go with which kind, and the tool
decodes what it is given with `WakeCondition` itself, so the union still decides what is accepted;
a condition that doesn't decode is refused with the reason under `condition:`. The result's `when`
states the condition with its defaults filled in, so the description doesn't list them.

A condition wake is a wake like any other. It counts toward the thread's cap of five, the user sees
it on the thread's chip and in the ledger (`wakes when acme/app main gets a new head, else …`),
`cancel_wake` drops it, and its time (`at` or `inMinutes`, else seven days on) is its fallback. A
condition already met when the wake is set is refused. Once a look finds it met, the finding is
kept on the wake and delivered through the same path as a due time: to the thread as a message
with the facts in a `wake-event` block, or into the orchestrator's next digest. A parked thread or
a paused workspace holds it, and a restart delivers it as it was found.

Each kind has a source on the server (`packages/server/src/wakes/condition-sources.ts`), which the
engine (`packages/server/src/wakes/conditions.ts`) runs. A source takes the condition's baseline
when the wake is set, then looks at every pending wake of its kind on a poll and whenever its event
source says something may have changed. A look that finds the condition met fires only if a second
look, the kind's debounce later, still finds it met; the second look's facts are the ones told.
`branchMoved` polls GitHub every two minutes, once per branch however many wakes wait on it, paced
to the background share of the API allowance, with a 30-second debounce. `threadFinished` looks
when the thread changes or a worker reports, and every two minutes, with a 20-second debounce.
`ciStuck` polls every two minutes with a one-minute debounce, and `machine` every 30 seconds
with none. `releasePublished` reads a package's releases through the user's own tools: `npm view <name> time
versions --json` with the user's npm (its registry, proxy and cache; Gram never reads `.npmrc`), or
`gh api repos/<owner>/<repo>/releases` on github.com with the user's gh, paced to the background
share. A read answers for every wake on that package for six hours; a failed one is never met and
is tried again after twelve hours, then once a day. Looks run hourly over what was read, so a
release passes its age within the hour without another read. `versionChanged` starts no probe: it
reads Gram's own version, and each CLI's off the launch checks' runs (at start, on Re-check, after
an update from Settings), looking as each finishes, ten seconds after the start, and every ten
minutes. Neither of these two has a debounce.

To add a kind:

1. Add a member to `WakeCondition` in `packages/contracts/src/wake-conditions.ts`, and its words in
   `wakeConditionWhen` and `wakeConditionLabel`, and its fields in `WakeConditionInput`, the flat
   shape the tool lists (`wake-conditions.test.ts` holds the two together). Add new optional fields
   freely. A change to what an existing field means bumps `WAKE_CONDITION_VERSION`.
2. Write a `WakeConditionSource` for it: `arm` checks the condition for the calling thread, fills
   in defaults, takes the baseline, and refuses one already met. `look` must not fail, and answers
   met (with its facts), not met (with a new baseline, if any), or `undefined` when it couldn't
   tell. Give it a `pollEvery`, a `debounce`, and optionally a `changes` stream.
3. List it in `WakeConditionSourcesLive`, and name it in `schedule_wake`'s description.

### Routines

A routine is a brief kept in the workspace's charter that runs on a schedule, or when something
happens: a daily CI triage, a weekly dependency check, a review of each PR that becomes ready. Each
has a name of its own in the workspace, a brief of up to 4,000 characters, and exactly one of a
`schedule` or an `on` event. A schedule is `every` `day`, `weekday` or `week` `at` a 24-hour local
time (for `week` a `day` from 0 for Sunday to 6, Monday when absent), or `every` `hours` with
`hours` from 1 to 168, counted from its last run. An event is one of a closed list, seen by polling
through the user's own `gh` and npm (no webhook, no public endpoint), why these four in
[the survey](design/event-routines-sources.md):

- `reviewRequested` (optional `repo`, `owner/name`): a review is requested from the user, as
  Notifications' review requests list it, once the review holds there let it through. It reads that
  poll's list and needs review requests on; while they are off the routine says so.
- `prReady`: a pull request in the routine's `project` opens ready for review or leaves draft;
  bots' PRs aside. One small GraphQL read every 10 minutes.
- `ciFailed` (optional `branch`, the default branch when absent): the newest commit on the branch of
  the routine's `project` with a completed Actions run has one that failed, timed out or couldn't
  start; PR runs aside. One REST read every 10 minutes.
- `releasePublished` (`source` `npm` or `github`, `name`, optional `minAgeDays` 0 to 90, 7 when
  absent, and keyed alike either way): the package publishes a stable release past the last one it
  saw, at least that old. Its first look takes the newest release already that old, so a younger
  one still fires once it is. Read at most every six hours; a burst of releases is one event, for
  the newest.

Each run starts a fresh worker in its `project`
(the home project by default) on its `model` (the roster's default by default), or, with `target`
`orchestrator`, puts its brief in the orchestrator's next digest. A workspace keeps at most eight.
Every write of the charter gives a routine without one an `id`, the one its name had if it had
one, so its runs follow it through a rename.

Three ways change them, all through the charter's one write path:

- Settings → Routines (also in the palette's Go to, and under Workspaces & merging) lists every
  workspace's routines, as a workspace's own settings do under Routines. Either adds, edits, turns
  off, removes and runs one now, and shows each one's last and next run (an event routine: whether
  it is watching, how many events wait, or why it can't look); a routine is edited in a dialog that
  names its workspace, whose When picks On a schedule or When something happens, then the event and
  its few fields. Each change saves with Undo.
- The orchestrator keeps them with `routine_create` and `routine_update` (`remove: true` deletes
  one). Their schedule is a few words: `daily 09:00`, `weekdays 09:00`, `weekly mon 09:00` or
  `every 6 hours`; or, instead, `on` an event in a few words: `review requested [owner/repo]`, `pr
  ready`, `ci failed [branch]` or `release npm|github <name> [min-age <days>]`. A routine is a standing change to the charter that starts work with nobody
  there, so adding one, turning one back on, or widening one (its schedule or event, brief, project,
  model, target or name) always asks the user, from the orchestrator as from a worker: a forced card for
  that call, showing the routine in full, that `bypassPermissions` and Full autonomy don't lift.
  Turning one off or removing one only takes autonomy away, and the orchestrator does that without
  a card. A change is pinned when the card is raised: the routine by its id, and exactly what it is
  and will be, both shown on the card. The approved call applies that and only that, and refuses if
  the routine changed meanwhile. A worker is bound `routine_create` alone.
- Settings by chat: `settings_propose` with `workspace.routines`, the whole list (each with its
  `schedule` or its `on` event), each brief in full on the card the user approves.

The orchestrator's charter names them, and an open session is told when they change.

How a run goes is the engine's (`routines/routines.ts`), its state kept in the workspace's outbox
under the routine's id:

- A routine's worker is the orchestrator's, spawned through the same `spawn_worker` path, so the
  workspace's autonomy, worker cap, limits, approvals and merge gates apply unchanged. The spawn is
  unattended: a run never raises a card. What would ask the user (one worker past the cap, a repo
  outside the workspace, the limit threshold's question without an answer for that window) refuses
  instead, the cap and the repos checked under the spawn's own lock so a racing spawn is counted,
  and a held brief of a routine keeps that rule when it is released. The run is recorded as failed,
  and the orchestrator's next digest says why. Its brief opens by naming the routine, and its
  header says "From routine <name>".
- Each run is one occurrence, claimed before it starts anything; the claim's request id is its
  spawn's, so a run a restart cut short finds its worker again and finishes one a crash left
  without its brief. The claim stays until the occurrence settles: while its brief is held, being
  released, or its worker is live, a due run is skipped and recorded so. Its phase is read from
  durable facts under the lock every release of a held brief takes.
- Every launch of a routine's worker goes through one admission, called while the spawn lock is
  held: a scheduled run, Run now, a held brief's release (by a reset, a probe or the user, after a
  restart too) and a half-made worker's recovery. It reads the routine as the charter has it then.
  One removed launches nothing; a scheduled run or a held brief launches nothing for a routine off,
  toggled or rescheduled since its run was decided; otherwise the worker starts with exactly the
  routine's brief, name, project and model then. A held brief it refuses is let go, not kept. A
  half-made worker is finished only in the project it was made in, and with the routine's name and
  model as admitted: one whose routine moved to another project, or to a model it can't switch to,
  is closed, and the next run starts a fresh one.
- A routine new, turned on again or given a new schedule is reckoned from then, never run for a time
  it missed. The charter's write path counts each turn off or on as a new generation, so a run that
  waited while the routine went off and on again reckons from then instead of running. Turned off,
  it keeps its claim, so a run still going is followed to its end and a
  worker a crash left half made is still finished; removed, its state goes, and a run that was
  under way doesn't bring it back. A run missed while Gram was closed runs once, a minute after the next start, never
  once per miss. A paused workspace pauses its routines: a run that falls due waits and runs once
  on the resume. An orchestrator routine's note goes into the digest once per occurrence.
- Times are read in the machine's time zone, so a daylight-saving change keeps 09:00 at 09:00; a
  time the change skips runs once that night.

An event routine comes due at each look instead of at a time, and its watch is kept in its state
(`trigger`) beside its runs:

- A look runs outside the engine's lock, since it may read GitHub, and what it found is merged under
  the lock only if the routine is still what was looked for. A look that couldn't tell (offline, out
  of the background allowance, the review-request poll not run yet) changes nothing, and after six
  in a row the row says so; one that can't look (gh signed out, no GitHub origin, a branch without
  CI runs) says why on its row.
- The first look after the routine is new, changed (another event or parameter) or turned on again
  records what is there as seen and fires for none of it. So does a look at another repository
  (or branch) than the one it seeded on: the routine's project, the home project or the origin
  changed. Turned off, its watch goes; its last run's time stays, so the cooldown holds across an
  edit.
- Each occurrence has a key (a PR's repo and number, a commit, a version), recorded as seen when it
  is first found, so it is delivered at most once, across restarts too. One that came while Gram was
  closed is found at the next start's look.
- A run delivers what waits, at most five events listed and the rest counted, taken out of the
  queue in the same write as its claim, so a run a restart cut short resumes with its own events.
  New events wait (at most 20, the oldest dropped and counted) while its last occurrence is
  unsettled, for 15 minutes after its last run, and while the workspace is paused; then they go in
  one run. While a live worker or a held brief holds them, the row says which. It is admitted,
  capped and refused like a scheduled run, but a run that started nothing (refused, no orchestrator,
  a limit, an error) puts its events back to wait, and the cooldown paces the retry; the
  orchestrator hears of a failure once, not at each retry. A run a restart cut short resumes with
  its events whenever it comes up, a pause included; a Run now a restart cut short puts its events
  back.
- The events reach the brief after the routine's own words, in a fence marked as untrusted
  external content: a title, a login or a workflow's name is someone else's text, data and never
  instructions. Run now runs it with what waits, or with none.

Source: [routines](../packages/contracts/src/routines.ts), [engine](../packages/server/src/routines/routines.ts),
[schedules](../packages/server/src/routines/schedule.ts), [events](../packages/server/src/routines/events.ts),
[tools](../packages/server/src/routines/tools.ts).

### Merge freezes

`merge_freeze` holds Gram's own merges onto a branch of one of the caller's workspace's repos (its
default branch unless one is named) for a reason, for at most 60 minutes. The thread that froze it
renews it by calling again, up to four hours from when it was first set; then it ends, the merges
it held go, and holding the branch again takes a fresh freeze. `allow` names up to four PR numbers that may still merge, such as the
release PR a cut freezes `main` for; a renewal without it keeps the list. While it stands,
`merge_when_ready` waits for every other PR and records why on the PR
(`main is frozen by "<thread>" for <reason> until HH:MMZ`), and `set_auto_merge` refuses them. A
merge whose last check passed, from `merge_when_ready` or `set_auto_merge`, is launched under a
fence the freeze also takes, so a freeze is either seen by that check or set after the launch. The
fence covers that merge's fresh read of GitHub too, so a freeze can wait behind a slow `gh` call
in flight. `set_auto_merge` reads the PR's base afresh when a freeze stands on its repo, so a PR
retargeted onto the frozen branch is held too.

GitHub merges a PR whose auto-merge is armed by itself. So a freeze turns off GitHub auto-merge on
the open PRs into its branch that belong to Gram's threads (the allowed ones aside), keeps them on
the freeze (each one before GitHub is asked, so a quit partway loses none), and arms them again
with the same method when it ends. If another freeze stands on the branch by then, they are
handed to it instead. A PR whose auto-merge someone turns off, whose merge is held, that is
unbound, or that closes or merges during the freeze is let go of at once and never armed again;
nor is one whose thread is archived, babysat or in a paused workspace when the freeze ends. It can't stop a person merging, auto-merge on a
PR no Gram thread has, or an entry already in a merge queue.

Only the thread that froze it, or its workspace's orchestrator, can lift it. It always ends at its
expiry: every read checks the time, whatever the timers did, so a thread that stopped, or a
restart past the expiry, never keeps it. A closed thread's freezes end with it. Its end looks again
at every armed merge in the repo, and fires `freezeLifted` wakes.

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
Gram keeps each window's share, peak and reset, and Codex's credit balance, in quarter-hour
buckets for 35 days (served by the hour for a month), pruned as they age. It keeps only those
numbers, never tokens, logins or account identifiers, and only for the CLI's own login.
Limits are per account, so they are not split by workspace or thread.

Standard/Fast speed is separate from reasoning effort. New choices default to
Standard; Fast is offered only with CLI/model support. Claude Fast is separately
billed outside included Pro/Max usage; Codex Fast uses more allowance/credits.
API-key sessions follow API billing. Gram preserves provider availability checks.

Gateways are opt-in URL/key profiles, selected explicitly. Saved keys or gateway
defaults never silently replace a local subscription. Gateway children keep their
credential homes isolated; local CLI authentication is not copied into them.
Gateway keys stay in Gram's local vault; subscription credentials stay isolated per provider.
Manual MCP configuration and each agent's own sign-in remain available; an agent may also
propose a server, which is added only on your approval (`mcp_server_propose`). Restricted
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

The orchestrator's chat has no row of counts over it: what runs, what is in review
and what merged are the sidebar's and the Board's. What needs you is not repeated
there either: the sidebar's pill is the one count across every workspace, and each
workspace's line carries its own share as a badge. Hovering the pill says how much is
here and how much is in each other workspace, by kind, and clicking it opens the Inbox
on the newest ask here, or anywhere when nothing here asks. With the sidebar hidden,
the title bar's Inbox button wears the count instead. Opened from the title bar or ⌘⇧I, the Inbox returns to
the item you left, or to the newest of the kind you last looked at. When you come
back after merges or failures, **Since you left** is one quiet line over the chat:
click it for the time range and each pull request, or dismiss it for that absence,
and the line goes. The
subscription limit lives in the title bar only. Digests that changed nothing for you fold into one update line, together
with the orchestrator's replies to them. These always stand on their own:
merges, deliveries, failures, questions, boot and away digests, and replies that
ask you something. **Show all activity** (the title bar's "…", under View) shows
everything, and so does finding a folded reply with ⌘F. Only the view changes: the orchestrator
still receives every digest.

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

## Permission modes by harness

The composer's modes mean the same thing on both harnesses: **Ask** asks before each edit and
command, **Accept edits** asks only before commands, **Plan** reads and plans, **Auto** lets the
agent's own reviewer decide and asks you only when it can't, and **Bypass** never asks. How each
CLI holds them differs:

| Mode                    | Claude Code                                                            | Codex                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Ask, Accept edits, Plan | Claude Code's own mode                                                 | `on-request` approvals in the `workspace-write` sandbox (no network); you review each request                                      |
| Auto                    | Claude Code's auto mode: its classifier decides each permission prompt | `on-request` in the sandbox with `approvals_reviewer = "auto_review"`, a Codex reviewer agent that approves or denies each request |
| Bypass                  | `bypassPermissions`                                                    | `never` with `danger-full-access`; under the outward gate `untrusted`, so Gram sees every command                                  |

**Codex's Auto** needs Codex 0.166.0 or newer, your own Codex login rather than a gateway profile
(nobody has checked that the reviewer's own model resolves through a gateway), and a thread with no
outward gate: a plain thread, or an orchestrator or worker at Full autonomy. Its reviewer answers in your place, so a request it
decides never becomes a card. A denial goes back to the agent, which tries a safer way or says
what stayed blocked, and the thread shows the denial and the reviewer's reason as a notice. So
does a review that timed out, whose action didn't run. Under Supervised and Publish the reviewer
would answer the outward gate's push or merge for you, so there, and on an older Codex, `auto` is
not Codex's Auto. Orchestrators and workers whose mode would be `auto` start in Bypass instead,
where the gate still asks, as before. A thread switched to `auto` there runs and shows `default`
(Ask). An orchestrator or worker that reopens where Codex has no Auto, after autonomy is lowered,
after a restart onto an older Codex or on a joined machine with one, is moved to Bypass again on
each reopen. On Codex 0.166.0 or newer, and under the gate on any version, every other mode names
you as Codex's reviewer, whatever your Codex config says.

**What a Codex worker at Full does differently.** Before Codex's Auto, a Full worker ran in Bypass:
`danger-full-access`, no sandbox. In Auto it runs in the `workspace-write` sandbox with the network
off, and what the sandbox blocks becomes an escalation for the reviewer. Measured on Codex 0.167.0
in a throwaway worktree, with Gram's exact settings, on 2026-11-10:

| Step                                  | Sandbox                                            | Result                         |
| ------------------------------------- | -------------------------------------------------- | ------------------------------ |
| `git commit` in a worktree            | blocked (`Operation not permitted` on the git dir) | escalated, approved, committed |
| `git push -u origin HEAD`             | ran inside the sandbox                             | pushed                         |
| `gh pr view`                          | blocked (no connection to `api.github.com`)        | escalated, approved            |
| `bun install --frozen-lockfile`       | blocked (`EPERM` on its temporary directory)       | escalated, approved, installed |
| `bunx vitest run` on one focused file | ran inside the sandbox                             | passed                         |

So routine work goes through, at the cost of one review per blocked command. Gram's own tools,
`local_check` and `merge_when_ready` included, are unaffected. The reviewer is told to deny
irreversible actions it can't see the user authorized, so a force push, a branch deletion or a
`gh pr merge` may still be denied, and Gram has no way yet to overrule a denial: the worker can
only work around it or report it. For workers that must never wait on a review, set the
workspace's worker mode to Bypass in Settings → Workspaces, which restores the old behaviour.

**Claude Code's Auto** routes most permission prompts to its classifier, including commands its
shell parser can't analyze, such as zsh expansion flags. A dangerous removal (`rm` of a system,
home or workspace directory, or of a target it can't resolve) is never the classifier's to allow.
Where nobody can be shown a dialog, as in Gram's sessions, Claude Code denies it and tells the agent
not to work around it. This is read from Claude Code 2.1.319, not measured live.

## Switching a thread's agent

A thread started in Claude Code can carry on in Codex, or the reverse, without starting a new
thread. The thread keeps its title, worktree, branch, plan, waits and wakes; only its agent, model
and session change. The new agent starts a fresh session and gets a handoff from Gram, so it
knows what happened without the old agent's memory of it.

Switching is offered only when the other agent's CLI is installed. With one CLI, nothing new
shows.

### Where to switch

- **The choices chip.** Under Model, the other agent's models follow the current agent's, under
  its mark ("Continue in Codex: new session with a handoff" on hover). Each ends in "…": picking
  one opens the confirm sheet and changes nothing by itself.
- **The thread menu.** "…" → Thread → **Continue in Codex…** (or **Continue in Claude Code…**).
- **The orchestrator.** Its "…" menu has the same item, and so does Settings → Workspaces →
  Models, beside "Current orchestrator". The chip's group isn't offered on the orchestrator.

All three open the same sheet. It shows the target model and effort (up to High), one line on
what carries over, one on what doesn't, and **Ask Claude for a handoff note first**, ticked. The
sheet preselects the target's model for the tier the current model fills, otherwise the target's
default, and keeps the current effort where the target offers it. When a greyed entry can't
switch, its hover says why.

### What carries over

The new session's first input is the handoff. Gram fences it as material from the thread, never
instructions, and it holds:

- **A note from the old agent.** Gram asks the old session for one last short turn: the goal,
  what's done, what's in progress, decisions and why, what's next, and traps. The note is capped at
  4,000 characters. Untick the box to skip it.
- **Gram's facts**, from Gram's own state rather than a model: the title and opening request, or
  a worker's brief; the plan and open asks; the worktree path, branch, HEAD and whether the tree
  is dirty; and a bound pull request with its checks, reviews, merge intent and monitors.
- **Recent turns** as text: your messages and the agent's replies, with each tool call cut to one
  line (such as `Bash: bun test foo`) and no output. The budget is about 12k tokens, the first
  request and the latest exchange first.

The new agent answers the handoff in one line and does no work in that turn. Messages you queue
during a switch wait and go to the new session after it.

What doesn't carry over: the old agent's tool output, its reasoning and its prompt cache. The
first real reply is slower, and the switch costs a full read on the other subscription, plus the
note turn on the old one. Switch at a natural break.

In the transcript a divider reads, for example, **Continued in Codex · GPT-6.1-Sol · 14:02**. Its
hover names the previous agent, model and session. Its chevron opens **What Codex was given**,
read only: the note and who wrote it, then Gram's facts. Rewind and fork stop at the divider.

The orchestrator's switch also flushes memory first, as before, and its note comes from that same
turn. The new orchestrator boots as usual from its role, memory, the charter and the ledger, and
gets the note plus your last 4 exchanges with it (about 4k tokens). Workers keep their own agents,
and the pick becomes the workspace's orchestrator model. Under the recommended setup that slot then
shows as yours, and **Follow recommended** puts it back.

### When the old agent is out of usage

When the old agent's own usage report says it is out of usage, or its last turn failed, it can't
write a note. The sheet says so in place of the checkbox, for example: "Claude is out of usage
until 15:00, so Codex's first turn writes the note from the transcript and does no other work."

In this limit mode Gram skips the note turn and sends about 24k tokens of recent turns instead of
12k (8k for the orchestrator). The new agent's first turn reads the handoff and the worktree and
replies with the note, before any work. That reply is stored as the note on the divider, under a
muted line such as "Claude was out of usage · this turn writes the note, no work". Queued
messages wait until that turn ends. Gram reads usage only from the agent's own report, never from
credentials.

### When a switch is refused

Gram refuses these on the server, and greys the entry with the same words where it can tell
beforehand:

| When                                                    | What you see                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| A turn is running or starting, or a switch is under way | "Wait for this turn to finish, or stop it, then switch."                                                                  |
| An approval, question or plan waits on you              | "Answer the open approval first. It can't move to Codex."                                                                 |
| The old agent still runs background work                | "Claude still has background work running."                                                                               |
| The other CLI isn't installed                           | Nothing is offered                                                                                                        |
| The other CLI is signed out                             | "Sign in to Codex in Settings → Agents."                                                                                  |
| A gateway profile on the thread                         | "Switching uses the CLI's own sign-in; it doesn't move gateway accounts."                                                 |
| The thread's session runs on a joined machine           | "Codex can't run on this thread's machine yet."                                                                           |
| A fork that hasn't sent yet                             | "Send once in this fork first."                                                                                           |
| An archived thread                                      | "Unarchive this thread before switching it."                                                                              |
| The worktree is busy                                    | "This thread's worktree is in use. Try again in a moment."                                                                |
| Plan mode the target can't keep                         | "The selected harness cannot preserve this session's Plan mode. Finish the plan in the current session before switching." |
| An effort above High                                    | "A switch runs at High effort at most. Pick High or lower."                                                               |
| A workspace approval gate the target can't keep         | The gate's own refusal, naming the mode                                                                                   |
| Windows                                                 | Nothing is offered                                                                                                        |

Plan mode, effort, the gate and a busy worktree show in the sheet after **Continue**, since only
the server knows them. A thread at its usage limit is never refused: that is limit mode. The
orchestrator's entry isn't greyed for a running turn or an open question, because its memory
checkpoint waits for them.

### Permission modes

The mode carries over through each agent's own mapping (see
[permission modes by harness](#permission-modes-by-harness)). The sheet names a change before you
confirm, and says nothing when the mode stays the same.

- **Claude Code to Codex.** Auto stays Auto on Codex 0.166.0 or newer with no outward gate. On an
  older Codex, a plain thread runs in Ask ("Codex runs this thread in Ask. Its Auto needs Codex
  0.166 or newer."), and a worker or orchestrator runs in Bypass. Under Supervised or Publish a
  worker or orchestrator runs in Bypass, where the gate still asks, so Codex's reviewer never
  answers a push or merge for you.
- **Codex to Claude Code.** Every mode carries over as it is.

### Workers

A switched worker keeps everything bound to it: its pull request, monitors, merge when ready,
dependencies, wakes, waits, plan, merge freezes and local checks. The sheet says so: "Its PR, merge
when ready and checks stay with this worker, and its orchestrator is told." The orchestrator still
directs the worker, and its next digest says it "continues in Codex (the user switched it)". Only
you can switch a worker: the orchestrator's `set_thread_model` keeps refusing a change of agent.

### Switching back

Switching back is another handoff to a fresh session, never a resume of the old one. It carries
the new note, the earlier note and the turns since the last divider. The sheet preselects the
tier's model, which may not be the model the thread started on. The old session is stopped, and
Gram never deletes the CLI's own files for it.

### Limits

- Not on joined machines, which run direct Claude Code sessions only.
- Not with gateway profiles on either side: a switch uses the CLI's own sign-in.
- Not on Windows, where Gram can't yet stop a session cleanly for a switch.
- Only you switch a worker; the orchestrator can't.
- The recent-turns budget is fixed, since neither CLI reports its context window to Gram yet.
- Limit mode has been tested only with synthetic usage reports, not with an account that ran out.

Source: [agent switch](../packages/server/src/runtime/agent-switch.ts),
[the sheet's words](../apps/web/src/thread/agent-switch-model.ts).

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
and branch; following a PR or checkout grants no ownership. When that check fails,
the card says why under its summary, the orchestrator's ledger line leads with a
`full auto, PR ownership unverified` tag, and the calling agent's result (declined,
withdrawn or approved) carries the reason and the fix. Explicitly name a
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

Any agent, an orchestrator, a worker or a plain thread, can propose an MCP server with
`mcp_server_propose`. The card shows everything that would be written: a remote server's URL
and host, or a local server's command line and env as written, under a line saying it runs a
program on this machine; then the scope (user, or the repo's `.mcp.json`) and each agent with
where it goes. Only on approval does Gram add it, through Settings → Connectors' own path
(`claude mcp add-json`, and Codex's own config write, which Gram's Codex home copies). A proposal
carrying a credential (a secret-looking env var, header, argument or URL) is refused: you add
those by hand. A name in use is refused unless the agent asks to replace it, and the card then
shows both. A remote server that needs a sign-in is signed in from the agent:
`/mcp` → Authenticate in Claude Code, `codex mcp login <name>` in Codex.

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

A `priority: "low"` brief is held, not spawned, when its agent refuses turns at a subscription
limit or the limit stands at the user's pause threshold; a share alone, even a full window, never
holds it, since credits can carry on past it. A digest tells the orchestrator when a held brief
starts. A recent auth, model-unavailable or network failure before any output holds spawns on that
model at either priority: the result names the failure, its time and the models clear of it, and
output on the model clears it, or one held worker probes after ten minutes. A retry with the held
brief's `clientRequestId` returns that brief; one without it holds a second copy.

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
and workspaces. Each reads GitHub afresh, compares the base branch's current tip with the one its
check ran on and launches under that branch's lock. GitHub's `baseRefOid` is not used for this: it
stays at the base the pull request last synced with until it is pushed to. After a merge, every
other armed `merge_when_ready` in the repository looks again, and a pass on the old tip runs again
on the new one. The lock fences only Gram: a push or merge by anyone else in between is for GitHub
to refuse, with a branch rule requiring pull requests to be up to date, or a merge queue.

Armed pull requests on one base take turns at the check, oldest first, because each merge voids a
pass on the old tip: N of them cost N checks in a row, not N side by side. A merge, or a failed
check, ends a turn at once; a pass that doesn't merge ends it after two minutes, so one pull
request can't hold up the rest. `local_check` asks for its own check and doesn't queue.

Before invoking `gh pr merge`, Gram records a durable fence for the base, the expected PR head
and the checked tip. Only fence commits reserve the SQLite connection and temporarily use
`synchronous=FULL`; each returns after its WAL sync, then restores `NORMAL` before ordinary
writes continue. A timeout, crash, interruption or ambiguous non-zero exit keeps that fence
across restarts and changes to the intent. Time alone never clears it. A fresh GitHub read must
show the PR merged at the expected head, or still open at that head after an explicit provider
rejection of the merge mutation. A generic process error, an unreadable response, a different
head or a closed PR leaves it fenced. Confirmed moved tips are retained across restarts too.

The owning worker is told immediately when the outcome is uncertain, and its ledger/status
waiting reason names the fenced PR and head. Inspect that PR on GitHub if it stays stuck; Gram
continues observing it but does not retry an ambiguous external write. A manual merge at the
expected head can resolve it. For a PR merged at another head, or closed without merging,
`resolve_merge_fence` is the explicit action named in its ledger waiting reason. The owning
orchestrator may call it for its worker; any other caller requires the user's approval card,
including a worker under full autonomy. Gram pins the approval to the pending attempt, reads
terminal MERGED or CLOSED state and the original base branch directly from GitHub, and rechecks
ownership atomically with the durable resolution. It never lifts a merge hold. It durably retires
older local passes, so later merges read the base fresh and use a check started after resolution.
An OPEN or unreadable PR, an unreadable base or a changed owner leaves the fence in place.
An unapplied timeout without terminal evidence stays fenced for human investigation rather
than guessing from an open read.

An armed merge that can't go yet says why on the pull request's status (`pr_status` under
`bound.mergeWaiting`, the ledger and the PR context): its turn, the pull requests in `after`, a
tip GitHub still reads as one Gram moved on from, a merge whose outcome isn't known, or GitHub out
of reach. The last three are asked again every two minutes, and after three of those Gram logs a
warning and tells the thread once.

A check under way when Gram quits keeps running under a wrapper that leads its process group,
writes the exit status beside the worktree and stops the group 30 s past the timeout. On the next
start a check whose process is verifiably the same is followed to its end, and one that ended
while Gram was closed keeps the status it wrote; both read **kept running while Gram was
closed**. A check whose process is gone with no status runs again once from the start and reads
**restarted after Gram quit**; a second cut-off fails with that reason.

Gram runs one local check at a time on a machine by default, or two with 12 or more cores;
`workspaces.localCheckConcurrency` (Local checks at once) changes it. A worker on a
[joined machine](MACHINES.md#its-local-checks) has its check run there, one at a time on that
machine. Waiting checks read
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

Workers can read their orchestrator's memory with `memory_list` and `memory_read`, while that
orchestrator holds the workspace, and can't change it: the orchestrator stays its one curator.
A worker's reads go through the anchored tree, every folder below the data root opened without
following a link, so no symlink anywhere in the path, standing or swapped in mid-read, leads into
another workspace. What a worker reads of memory is an allow-list that fails closed
(`orchestration/memory-filter.ts`). It lists only names of lowercase words joined by `-`, in
folders named the same way, ending `.md`, with no credential word and no token shape in them (a
known token prefix like `xoxb`, long digit runs, letter-and-digit alternation, random letters,
base64 of text), so not the `MEMORY.md` index. It reads a file only when the file is plainly safe
prose: printable ASCII, typographic punctuation and Latin-1 letters (folded to ASCII before any
check); no escape or encoding syntax (`\u`, `\x`, `%XX`, `&#`, `&name;`) or delimiter left open;
no URL or network-path userinfo (`//…@`, `user:pass@`), connection string (`Key=value;` fields),
password-file record (four or more non-empty `:`-separated fields, as in `.pgpass`, not IPv6),
`user:pass` pair ending a short line or as a value (`login=amy:pw`), Redis ACL rule or `AUTH`
command (after a prompt or in a sentence), or client password option (`curl -u user:pass`, a
`-p`/`-w`/`-a` beside a user flag); no strong credential word or stem anywhere (secret, token,
key, password, pwd, cookie, credential, bearer, dsn, `requirepass`, `masterauth`, `client_send`,
a word ending in `pw` like `bindpw`), nor a weak one (auth, session, pass, env, private, acl,
login, bind) with a value right after it or leading a bare directive line (`AUTH amy orchard`,
not a sentence), camelCase and snake_case split first; no base64 or hex that
decodes to text, however it is split (spaces, lines, commas, list markers, quotes); and no
token-like run once cited commit SHAs (a pure hex run after `at`, `head`, `commit` or `sha`, or
before `…`, in a clause with no assignment or credential word) and plain paths are taken out. A
header, if any, is one closed `---` block that is a flat map of plain scalars with no `private` in
it. Anything else is dropped whole, never redacted or partly shown; the orchestrator sees it
all. A worker offers a lasting fact for memory with `learned` on `report` (up to 500 characters); the
digest shows it to the orchestrator, which records it only when it holds for later work. Solo
threads have no workspace memory.

### Known limits of worker memory reads

The worker read filter is defense in depth, not a guarantee. It lowers the chance that a
credential copied into memory reaches a worker's provider through `memory_read`; it doesn't make
memory a safe place for credentials.

- **Workers can read the files directly.** A worker is a local agent CLI running as the user on
  the same machine. Memory lives under Gram's data folder
  (`<data>/orchestration/<workspace>/`), and the filter only governs the `memory_list` and
  `memory_read` tools. A worker allowed to read files outside its checkout can open them there.
- **Writes are scrubbed, more narrowly.** What Gram writes to memory (`memory_write`,
  `memory_append`, `memory_edit` and a memory update's adoption) passes through the same scrubber as
  Gram's logs, which redacts the credential shapes it knows. That scrubber is narrower than the
  read filter, and a file edited by hand outside Gram isn't scrubbed at all.
- **What reviewers found, and what's left.** Independent reviews of #198, rounds 8 to 13,
  found the classes below. Each is fixed and has a test in
  `orchestration/memory-headers.test.ts`. Encodings and formats not yet covered may still get
  through.
  - Front matter that hides a private flag: a `...` close, comments, other fence styles, nested
    or tagged YAML.
  - Auth headers and cookies, including credential labels written with `_` as the separator or
    inside camelCase and other compound names.
  - Encoded credentials: escaped, percent-encoded, HTML-encoded and base64 forms, including
    nested and mixed encodings, short or line-wrapped base64, and base64 or hex split up by
    punctuation, list markers or quotes.
  - Look-alike and invisible characters: full-width letters and zero-width separators.
  - Credentials behind a delimiter left open, such as an unclosed key block or code fence.
  - Token-shaped file and folder names.
  - User and password pairs in URLs, including scheme-relative ones.
  - Database connection strings, and password-file records like `.pgpass` lines.
  - Redis, LDAP, SMTP and proxy configuration directives, and Redis `AUTH` in a prompt
    transcript or a sentence.
  - Passwords given as command-line options, as `curl`, `docker login`, database clients and
    `ldapsearch` take them.
  - A labelled credential that the commit-SHA exemption let through.
- **Two accepted limits.** A token typed one character at a time between separators reads,
  because no single piece looks like a token. An unlabelled hex value written as a cited commit
  reads, because it can't be told apart from a commit SHA.

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

Codex helpers use the guided adapter built for **CLI 0.166.0**. Newer CLI versions
are accepted with a compatibility warning. It uses
separate ephemeral threads with no environment, requests read-only/no-network
permissions and forbids escalation. Some models can still be offered `apply_patch`, which
has no environment to run in. The child pins and verifies the built-in
ChatGPT inference route before delivering context, overriding inherited custom
endpoints only for that helper child. Older or unknown versions refuse with setup
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

## Memory updates and selected-harness support

A memory update prepares a candidate. Review is the default; per-run Auto adopts only validated,
bounded memory output and preserves native permissions. It is a separate
transport and permission decision from helper generation and ordinary coding.
Claude Code supports bounded file-tool memory updates on macOS/Linux with
`/usr/bin/python3`: snapshot inputs read-only, candidate/notes writable, native
tools disabled.

Codex memory updates are guided at CLI 0.166.0: workspace-write sandbox and on-request
approvals, with instructions guiding snapshot reads and candidate writes. Native
tools can access other permitted files. Gram validates candidates before Review/Adopt or per-run Auto applies them. Complete file-only native-tool confinement is unavailable;
strict file-only policy refuses this route. Newer installed Codex versions are accepted
for memory updates with a compatibility warning. Older or unknown versions remain unavailable
for memory updates while ordinary sessions stay available.

Selected-harness preflight reads discovery, model/profile and support before
startup. It does not run a provider turn, open a page or grant permissions.
Admission revalidates startup inputs; stale roster/membership changes require retry.
Source: [memory update support](../packages/agents/src/dream-support.ts),
[support service](../packages/server/src/agent-support/service.ts),
[memory update service](../packages/server/src/orchestration/dreams.ts).

Automatic memory updates are off by default. Each workspace's settings page (Settings → Workspaces,
then Advanced) can start a memory update after 1–1000 distinct completed worker or conversation threads (initial
editable value 10). Completion means an agent/user completion mark or a merged PR;
a reply ending or becoming idle does not count. Memory update and orchestrator threads and helper
jobs do not contribute. Ordinary conversations follow the workspace's project inputs;
workers belong to their owning workspace.

Enabling or editing the threshold starts a fresh count without historical catch-up.
Successful manual and automatic starts reset progress; failed or cancelled runs need
fresh completed threads. Seen IDs survive restart and reopening while their live,
closed or archived history is retained. A restart preserves recorded progress but does
not count missed completions or replay a launch. Pauses, user holds, running memory updates and
unavailable selected models defer launch. Relevant external activity or settings changes
recheck a deferred launch; no UI timer runs it. Progress and deferral appear beside the
setting. Automatic launches always use Review; they grant no global adoption authority.
Scheduling uses the memory update service's one start lock, with a durable claim before launch;
exclusive coordination across independent server processes is not established.
Source: [scheduler](../packages/server/src/orchestration/automatic-dream.ts).

## Codex ownership and reopening

The provider-thread fence outlives Gram listeners and discovery-server retirement.
As measured at 0.162.1 and assumed since, `thread/closed` or unsubscribe acknowledgement cannot establish
recorder/writer release. Only observed **owning-child exit** clears the fence.
After closing the final Gram scope, both replacement-child resume and same cached
child reopen refuse while that owner lives, including normal closed-thread reopen.
Held sibling sessions are preserved; Gram does not kill them to clear the fence.
Multiple scopes on the same exact child/auth identity are counted. An unsettled
open conservatively requires owner exit too. This is not an OS-wide ownership lock
across independent server layers or Gram processes.

Source: [thread ownership](../packages/agents/src/codex/thread-ownership.ts).
See [verification](VERIFICATION.md#protocol-native-and-live-checks) for synthetic and live lifecycle checks.

## A broken configuration file

Two files are made to be edited by hand, by you or by an agent you ask:
`keybindings.json` in Gram's data folder (Settings → Keyboard writes it too) and a project's
`.gram/scripts.json`. A broken edit never breaks what they configure. Whenever a version reads
cleanly, Gram keeps a copy of it as the last good one. When a later edit doesn't read cleanly,
whether it is invalid JSON, the wrong shape or one bad key chord, that edit is ignored as a whole,
the last good version stays in use (across restarts too), and Gram writes why:

| File                 | Last good copy                                                      | Why it isn't used                                          |
| -------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| `keybindings.json`   | `keybindings.last-good.json` beside it                              | `keybindings.json.error` beside it                         |
| `.gram/scripts.json` | `project-scripts/<project id>.last-good.json` in Gram's data folder | `project-scripts/<project id>.error` in Gram's data folder |

The error file names the broken file, lists each problem and says which version is in use. It is
deleted once the file reads cleanly again. Settings → Keyboard and the scripts editor show the
same problems. Nothing is written into the project's own folder. Deleting a file isn't a broken
edit: no overrides, or no scripts, then apply. Without a last good version, Gram applies what it
could read, as before.

## The agent guide

Each time it starts, Gram writes `AGENTS.md` into its data folder: a guide for agents to read on
demand, generated from the release that runs. It explains the roles and approval classes, lists
the files above that an agent may read or edit (and the error files), every setting
`settings_read` shows (and the user-only ones, with why), and every tool, with its class, its
roles and its input fields. `settings_read` names the file's path in its result.

The guide costs nothing until an agent reads it, unlike a tool's description, which every session
pays for at its start. A test (`packages/server/src/guide/agent-guide.test.ts`) builds the whole
server and fails when the guide misses a tool any role is bound with, or a setting. Edits to the
file are replaced at the next start.

## Project scripts

A project's common commands (build, test, lint, dev) can be saved as project scripts and run
with one click or key instead of retyped or asked of an agent. They live in
`.gram/scripts.json` in the project's own folder, beside `.gram/launch.json`, as plain JSON a
person can edit:

```json
{
  "scripts": [
    { "name": "test", "command": "bun run test", "shortcut": "mod+alt+t" },
    { "name": "web dev", "command": "bun run dev", "cwd": "apps/web" }
  ]
}
```

`name` (up to 64 letters, digits, spaces and `. : / _ -`) and `command` (one line) are required.
`cwd` is a folder relative to the checkout, which must stay inside it. `shortcut` is keys in the
keyboard settings' form and needs ⌘/Ctrl or ⌥ with a letter or digit, or a function key.

Add and edit them from the **Run script** menu, a thread's **Project scripts…** (its More… or the
palette), or under
Settings → Workspaces → a workspace → Project scripts. On first use the editor offers
`package.json`'s scripts, run through the package manager its `packageManager` field or
lockfile names, and a Makefile's targets, each with an Add button. Nothing is added or run on its
own.

A script runs when the user picks it from **Run script** (the Terminal tab's ▷, and the header's
▷ once the project has scripts, which a narrow title bar folds into its …),
from the palette's **Run script…**, or presses its key. It runs in the active thread's checkout
(its worktree), in a Terminal tab named after it that shows the command first and keeps its
output; running it again replaces that tab. The tab shows the run as running, finished (green)
or failed (red). The menu shows each script's exact command, with its folder in the tooltip.

Definitions are read from the project's own folder each time, not from the thread's worktree, so
an agent editing its worktree's copy changes nothing. No agent tool runs a script: only the
user's click or key does.

## Agents after Gram quits

Off by default. **Settings → General → Running work → Run agents after quit** runs this machine's
host as a service of your user that outlives the app, the way a [joined machine's](MACHINES.md#the-background-service)
`gram-host` already runs. It takes effect when Gram next starts.

| Platform | Service                                                                        |
| -------- | ------------------------------------------------------------------------------ |
| Linux    | systemd user unit `~/.config/systemd/user/gram-local-host-<id>.service`        |
| macOS    | launchd agent `~/Library/LaunchAgents/io.github.ant1off.gram.local.<id>.plist` |

`<id>` comes from Gram's data folder, so a release and a checkout of Gram on one machine never
share one. Windows has no such service, and the setting isn't offered there.

While it is on:

- **Quitting Gram leaves its Claude sessions running.** A turn goes on to its end, and a terminal's
  shell keeps running. An approval, a question or a plan the agent asks for while Gram is closed
  waits for you, as on a joined machine. Gram's own tools (`gram` MCP) answer only while Gram is
  open: a call made while it is closed fails, and the agent sees why.
- **Opening Gram picks them up.** Each thread whose session is still there gets its turn back, under
  the same id. What the agent did while Gram was closed is replayed into the transcript, the reply
  in progress whole, and a request it is waiting on shows again. Nothing is opened afresh and
  nothing is run twice. The session's tools are pointed at the new Gram.
- **Quitting with agents still in it shows one notice:** "2 agents keep running. Open Gram to see
  them."
- **Settings says where it runs** ("Running as `gram-local-host-….service`, with 2 agent sessions
  that go on if Gram quits"), and **Stop now** ends it at once, after asking when sessions are in
  it. Turning the setting off stops it, and what is in it, when Gram next starts, and removes its
  files.
- **It never lingers.** It isn't started at login, only by Gram. With no Gram connected and nothing
  running, it ends after 10 minutes. If a session holds something Gram hasn't seen yet, such as a
  reply finished while Gram was closed, it waits for Gram to open, for up to 3 days. Stopping it
  ends what it started, as far as each platform can hold it:
  - **Linux:** the systemd unit's control group holds everything the service started, whatever a
    process does to its environment, session or parent. Stop is verified on that group: it succeeds
    only when systemd says the unit is inactive and its group is gone or empty.
  - **Every platform:** each start gives the service a random run token in its environment, which
    its agents, shells and tools inherit. Each start's token is kept, in Gram's data folder and in
    the registry below, until a stop or a later start (with the service not running) has ended that
    run's processes and verified it. A start that fails keeps them too. Stop then ends every
    process of yours carrying an outstanding token. It matches by your effective user and by the
    token as an entry of the process's environment, never by text in a command line, and checks
    each process's start time again right before each signal. A process list it can't read in full,
    on any pass including the one after SIGKILL, fails Stop and keeps the records, and Settings
    says to try again. Starts and stops of one instance are serialized by a lock.
  - **macOS:** launchd ends the job's process group. The token sweep then ends what left it while
    keeping the token. Not guaranteed: a process that both clears its environment (`env -i`) and
    leaves the job's process group (`setsid`), or whose environment `ps` can't read, can outlive a
    Stop. macOS offers no equivalent of a control group to hold it.
- **Releases may differ.** A Gram that finds an earlier release's host still running uses it, since
  between releases the host protocol only grows (see
  [machines on different releases](MACHINES.md#machines-on-different-releases)). When nothing of a
  thread is in it, Gram restarts it on its own release.

Codex sessions, sessions through a gateway profile and memory updates still run inside Gram and
stop when it quits. The host listens on a Unix socket in Gram's data folder
(`local-host/host.sock`, or a private folder under `$XDG_RUNTIME_DIR` when that path is too long),
in a folder only your user can open, and on nothing else.

**What it defends, and what it doesn't.** The host is protected against other users of the
machine and against anything unauthenticated or on the network: the socket's folder is yours
alone (0700), and the install's secret (`local-host/secret`, 32 random bytes, 0600) is readable by
you only. Before any of the host protocol, the app and the host each prove they hold that secret
with an HMAC over a nonce the other side chose. The secret never crosses the socket. Every frame
after that carries a MAC under a key derived from the secret and both nonces, over its direction
and its number in sequence. So a process that relays the handshake without holding the secret
can't add, alter, replay or reflect a frame: the connection closes on the first one that doesn't
verify, and an unproven connection never displaces the connected app. The host does **not**
defend against code running as you. Such code can read the secret, as it can already read the
CLIs' logins and the rest of Gram's data, and same-user programs are inside Gram's trust boundary.
Frames are authenticated, not encrypted: what crosses the socket (an MCP bearer token, say) is
readable to whatever can reach the socket. Only code running as you can, through a 0700 folder, and
that code is trusted, so encryption would add nothing. Gram refuses to start the host, or to use its
secret, when the socket's folder or the secret's is looser than 0700, the secret looser than 0600,
either belongs to another user, or either is a link. It never loosens or repairs them silently. The
service is told the secret file's name, never the secret. Starts and stops of one host are
serialized by a lock that is taken over only once its owner process is verifiably gone. Its environment file carries only `PATH`,
locale and XDG folder names, `CLAUDE_CONFIG_DIR` and Gram's own settings for it, never a token, key
or proxy address. Claude Code finds your sign-in where it keeps it, as it does from a terminal. Gram
keeps a record of the sessions it left running (`local-host/sessions.json`, readable by you only).

On macOS, Gram starts the agent through `launchctl` rather than as its own child: a process the app
spawns stays in the app's coalition, which macOS can end with the app. launchd goes on running the
definition it loaded, whatever the file says now. So Gram boots any job left by an earlier start
out first, and loads the rewritten one once launchd no longer has it.

On macOS the definition sits in Gram's data folder, not `~/Library/LaunchAgents`, and has no
`KeepAlive`, so launchd never loads or starts it at login: only Gram does.

Gram also keeps a registry of these services outside any data folder (`~/.local/state/gram/kept-hosts`
on Linux, `~/Library/Application Support/Gram/kept-hosts` on macOS), one file per data folder,
naming the service and its run token. A data folder that is moved or removed can't be reached by
any Gram again. Its service ends on its own 10 minutes after its secret disappears, whatever it is
running, and the next Gram to start, whichever data folder it uses, stops it (verified) and only
then removes its registry entry. A service whose data folder is still there is never touched by
another Gram, so a closed Gram's waiting approvals stay waiting.

To stop one by hand, find it in the registry (each file names its data folder), then:

```sh
# Linux
systemctl --user stop gram-local-host-<id>.service
# macOS
launchctl bootout gui/$(id -u)/io.github.ant1off.gram.local.<id>
```

Then end anything still carrying its run token (`GRAM_LOCAL_HOST_RUN=<token>` from the registry
file) and delete the registry file.

A session taken up on reopen has its Gram tools pointed at the new Gram. That is tried again every
second until the new Gram's MCP endpoint answers, which is a moment after it starts.

## Terminals after a restart

A thread's terminal that was still open when Gram quit, crashed, or lost the machine it ran on
comes back on the next start, in the same tab, folder and shell. It shows its last screen as plain
text (a full-screen program's last frame included) above a dim line, `── the program above ended;
this is a new shell ──`, and a fresh shell below it. The command that ran is never run again, so
a script's tab comes back as a plain shell.

What comes back is the terminal's kept tail: up to 256 KB of output, of which the last 1,000 lines
are shown. Gram keeps it in its data folder (`kept-terminals`, readable by your user only) while
the terminal is open, a second after new output, and deletes it when the terminal closes, its
program ends, or its thread closes. A terminal whose thread or folder is gone stays gone, and so
does one opened outside a thread. A joined machine keeps its own in its host folder.

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

The Preview tab opens your app's dev server, a Markdown or HTML file, or any web page you type
(`example.com` opens as https), and follows links within a web page. `file:`, `javascript:`,
`data:`, `chrome:`, `devtools:` and other schemes never open. A new window, and a local page's link,
script or redirect off loopback, go to your browser through the link question: only the address
strip opens a web page in the pane, so an agent's local page can't send it into your sign-ins. Each thread's page lives in one of two sessions of Gram's own, kept in memory, sharing
nothing with the app's session, its launch cookie or your browser, sandboxed and without Node, with
every permission, download, client certificate and external-app launch refused:

- **Local**: loopback pages and every page an agent drives. It loads nothing off loopback but what
  an agent was allowed (below).
- **Web**: the pages you open anywhere else. No agent ever reads or drives one; when an agent
  starts browsing in that thread, your page there closes for a fresh one of its own, so what you
  sign in to on the web stays yours. Pages on the internet share one web session, which never
  reaches loopback (Gram's own server, your dev servers) or a private network, whatever asks: a
  link, form, redirect, script, frame, subresource, WebRTC or preconnect. A public name pointed at
  a private address is refused like the address. A page you open on your private network, by its
  address or a private name (`nas.local`), gets its own private web session for that thread and
  that host and port, which reaches no other private place: not another address, port or name,
  whatever asks, a frame, WebRTC or a preconnect included. Another private place takes typing it;
  a link to one goes to your browser through the link question. A public frame there doesn't
  load, and a link to the internet opens in the shared session. A public name that resolves to a private address (split-horizon DNS)
  opens nowhere in the pane. Each web session's connections go through a proxy of its own, which
  looks each name up once and connects only to the addresses it checked; it answers only its own
  credential, made at each launch, so no other program on your computer can use it. The system
  proxy isn't used, so on a network that requires one, web pages don't load in the pane. WebRTC
  there uses no UDP, and its TCP goes through that proxy too. When the pane closed your web page
  for newer threads', it re-opens it by the shell's own token for that page and at the address the
  shell recorded; once anything else opened in the thread, such as an agent's page, it doesn't.

Agents can't open a web page in your Preview tab with `show_panel`, which stays on loopback; they
browse with the tools below, under their own approvals.

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

### The agent browser without the desktop app

Where Gram runs as a server alone, as [in Docker](DOCKER.md#the-agent-browser), the same
`browser_*` tools drive a headless Chromium on the server instead of the Preview pane. The server
forks a browser host (`GRAM_HEADLESS_BROWSER`, the path to
`packages/shell/src/modules/agent-browser/headless-host.ts`), which runs the pane's own code and
rules over Chromium's DevTools Protocol, so approvals, takeover, the per-submission card and
evidence work as in the app. Without that variable the tools answer that there is no pane, as
before.

That browser reaches the server's loopback only: an agent's dev server there, never the internet
or a private network. Chromium starts with every connection sent to a closed proxy, with loopback
alone exempt (its usual exemption for link-local addresses, where a cloud's metadata service
lives, is taken away), so `127.0.0.1`, `[::1]` and `localhost` load and no other loopback
spelling does. No name but `localhost` resolves, so nothing a page writes leaves in a DNS query.
A page here gets no WebRTC, and if it found some, WebRTC may use that proxy or nothing, so it
sends no UDP. Each of the
page's requests is also paused and put to the pane's rules, then to the Preview's local-session
rules; a worker's requests get the local-session rules. A page's script can't open a window, and a window that opens all the same (a link, a shifted click) is closed at once, since no command drives it; its first request may still reach loopback, and nothing else. A `browser_navigate` anywhere else is refused
before any card, and a navigation the page itself starts off loopback ends where it began.

Each thread's page is a browser context of its own, sharing no cookies or storage. Four threads
keep a page at once; the one whose last command is oldest closes for the next, never one with a
command running. The profile is a fresh temp
folder, removed when the browser stops. The browser starts on the first command and starts again
on the next command after it stops. Neither the browser host nor Chromium gets the server's
environment: only the paths, locale and font settings, and the variables below. A load whose server doesn't answer in 30 seconds is stopped. A page's `alert`, `confirm` or `prompt` is dismissed, since nobody is there to answer it. A page that stops answering for 40 seconds, such as one whose script loops, is closed, and the next command opens a fresh one. One multicast DNS query can still leave the machine when a page hands WebRTC a `.local` name, carrying a fixed name and nothing of the page's. Recording (`browser_record`) needs the desktop
app's image decoder and doesn't work here.

You watch that page in the thread's Preview tab, in a browser tab or any window with no Preview
pane of its own: the tab shows the page live from the server, with the agent's latest action above
it, and comes up by itself when the agent browses. A click, a key or a scroll in the page takes it
over, as in the desktop app: your input goes to the page, and the agent's next input is refused
until it has the page again. It gets the page back when you press **Hand back**, when you have sent
nothing for 20 seconds, or when you close the tab. Back, forward and reload in the strip are yours
too. The address is shown, not typed: the tab shows the page the agent opened, and opens none of
its own. File uploads and sound don't cross.

Keys reach the page as you type them, with two limits. Only a keyboard's ordinary keys are sent,
so the browser's own shortcuts never are: no function, media or browser key, nothing with Alt that
types no character, and Ctrl or Cmd with no key but the editing ones (select all, undo, redo,
moving and deleting by a word or a line). Nothing you press opens a window, the developer tools or
a print dialog on the server, and a window of the browser's own that opens all the same is closed
at once. And copy, cut and paste aren't sent, by their shortcuts, their own keys or the middle
mouse button: the server's browser has one clipboard and one selection that every thread's page
shares, and yours stay on your machine. Shift+Esc puts the keyboard back in the strip, so the page never traps it; a mouse button
or a key still held when the page goes back to the agent is let go first.

The frames are JPEGs of the page as it repaints, twelve a second at most, sent only while someone
watches (`browserView.subscribe`); input goes back as `browserView.input`, which the browser host
checks before it reaches Chromium. Only a member calls these, never a viewer. A desktop app
connected to a server that runs its own browser still shows its own Preview pane, not the server's
page.

| Variable                  | What it sets                                                                 |
| ------------------------- | ---------------------------------------------------------------------------- |
| `GRAM_HEADLESS_BROWSER`   | The browser host the server forks; unset, there is no browser                |
| `GRAM_BROWSER_EXECUTABLE` | The Chromium or Chrome the host starts                                       |
| `GRAM_BROWSER_SANDBOX`    | `0` starts it without Chromium's sandbox, which a container's user can't use |

### Pinned pages

An HTML page an agent drafts in its folder and shows in the Preview tab (`show_panel`) can be
kept. A page meant to be pinned builds its content with DOM APIs, never `document.write` or
`document.open`, which throw once it is pinned (below). **Pin** in the Preview tab's strip keeps
one: it copies the page's folder into Gram's state on this computer
(`<data dir>/pages/<workspace>/`), as Docs are kept, and opens it in the **Pages** tab,
which the panel shows while the workspace has a pinned page.
Only you pin, show a newer version or unpin; no agent tool does. Nothing done in the worktree
afterwards changes what you pinned. A pinned page is a bundle: its folder, with a `manifest.json`
at its root naming the entry file and the data the page declares it reads, which is none for now.
A folder of more than 400 files or 32 MB, deeper than 8 folders, or whose own `manifest.json`
names another entry or declares a read isn't pinned. Dotfiles, credential files and links are left
out. Only a page in the thread's own folders, on this computer, in a workspace, can be pinned.

An agent offers a new version with `offer_page_version`, which copies its file's folder the same
way. The page keeps showing your version, with "Newer version from … · Show it" under its header,
until you press Show it. A later offer replaces one you haven't shown.

Gram's header above the page names it and the thread that made it; the page draws nothing of the
app's. It runs in a session of its own, `gram-pages`, kept in memory and hardened like the
preview's, which no agent reaches: the browser tools and `show_panel` refuse its address, and the
Preview tab's local session never loads it. Its page listener, apart from the preview's, serves
each pinned version under a token of its own, and the session loads that page's own files from it
and nothing else: no other page's, no other origin, no network, socket or WebRTC, no
app IPC or bridge. The page runs sandboxed at an opaque origin, with no cookies, storage,
popups, forms, dialogs or downloads, and can't navigate off its own files. Both the listener and
the session put that policy on every response, so neither alone keeps the page in. The page's
frames run one preload first, which exposes nothing. Chromium lets a page with your click write
the clipboard whatever the session allows, so the guard promises this much: the page can't write
the clipboard by script (its copy, cut and paste commands are refused, whatever names them), and
can't see or change the clipboard's data when you copy, cut or paste. Its handlers don't hear the
`beforecopy`, `beforecut` and `beforepaste` events or the copy shortcut's keydown (Ctrl or Cmd+C,
Ctrl+Insert), so it can't move your selection just as you copy. It doesn't promise that what you
see is what you copy: a selection that spans text the page hid (styled away or off screen) copies
that text too, as in any browser, and the page can still move the selection at other moments.
Nor does it cover the cut shortcut (Ctrl or Cmd+X, Shift+Delete), whose keydown the page still
hears, or dragging text out of the page, whose `dragstart` handler can set what is dragged.
So that nothing gets ahead of the guard, a pinned page can't replace its own document:
`document.open`, `document.write` and `document.writeln` throw, so agents build pages with DOM
APIs (`offer_page_version` says so). A `srcdoc` child the page makes runs the guard too. A child
it makes by script at `about:blank` gets no preload; the sandbox's opaque origin is what keeps the
page from scripting it.

### Your own browser: Claude in Chrome and Codex computer use

The Preview pane is Gram's own browser. A thread can also be given **your** browser, with your
sign-ins, for work only a web console can do (an OAuth app's settings, a cloud project, a
tailnet's admin page). Every consent is off by default, and each one is separate:

- **Per agent**, under Settings → Agents → Your browser: **Claude in Chrome** for Claude threads,
  **Codex computer use** for Codex threads (`agents.claudeInChrome`, `agents.codexComputerUse`).
- **Per scope**: a plain thread gets it only when you give it with ⌘K on the thread (**Lend it your
  browser**, `thread.setBrowser`). Under Settings → Workspaces, **Orchestrators use
  your browser** (`workspaces.orchestratorBrowser`) gives it to orchestrators, and **Give workers
  your browser** (`workspaces.workerBrowser`) lets an orchestrator pass `browser: true` to
  `spawn_worker`. A spawn that asks without those consents starts without it, and its result says
  why.

While a session that was opened with the browser runs, the chip also says when it isn't ready,
from that session's own MCP servers: **Your browser isn't ready** when Claude in Chrome's server
is listed but not connected, or when a Codex session has no computer-use server or one that
failed. It says nothing before such a session runs, or when Claude Code doesn't list the server.

These are user-only settings: no agent can turn one on through `settings_propose`. Gram reads them
again at each session open, so a change applies from a thread's next session. Giving or taking it
with ⌘K reopens the session once it is idle. The pane header shows what the server says the
thread's next session gets (`thread.browserStatus`): **Your browser** while it has it, **Your
browser isn't ready** while its session can't reach it, **Browser held back** while a consent
holds it back, and **Browser not available** where its session can't have
it at all: a Codex thread in Gram's own Codex home, a thread on a gateway, or one started from a
profile. The home is the one the thread's next session actually opens in, from the same resume
plan: a fork that hasn't run yet resumes its source session in the source's home. There ⌘K's lend command is dimmed with the reason, and `thread.setBrowser` refuses it. A
dream never gets it.

**Claude.** A session given the browser starts with Claude Code's `--chrome`. There is no Agent SDK
option for it, so Gram passes the flag through `extraArgs`. Every other Gram session starts with
`--no-chrome`, so Claude Code's own "Enabled by default" setting or `CLAUDE_CODE_ENABLE_CFC` never
reaches a thread you didn't give it. A session that doesn't say is held off too. A session runs
in this machine's or a joined machine's gram-host only where that host names the `browser-policy`
feature: an older host would drop the denial and run the CLI's own default. This machine's older
host leaves its sessions to the server, and a joined machine's older host is refused until Gram is
updated there. It needs the Claude extension installed and connected in
Chrome, and a claude.ai sign-in: a thread on a gateway or an API key doesn't get it. Its tools are
`mcp__claude-in-chrome__*`. Under a workspace whose outward gate asks about everything
(supervised), Gram asks before each action in the browser (click, type, navigate, run script,
upload, open or close a tab). The read-only tools don't ask: page text, find, console, network,
tabs. Under the publish gate, Gram can't tell a click that merges a pull request from one that
doesn't. There, the permission mode and the extension's own site permissions decide.

**Codex.** Computer use comes from the plugins the ChatGPT app installs in your own Codex setup
(`unified-computer-use@openai-bundled` serves `cua_repl`), plus the `node_repl` server it writes to
`~/.codex/config.toml`. Without the consent and the grant, Gram turns those plugins off in the
thread's config, along with each computer-use server your config has. Your other plugins and
servers are left as they are. It works only in threads that run in your own `CODEX_HOME`: threads
under an outward gate run in Gram's own Codex setup, where plugins are off. Codex computer use
also needs the ChatGPT app.

**What Codex reaches.** Under the Codex switch, three more choose what a Codex thread given the
browser keeps: **Codex in your Chrome** (the ChatGPT extension), **Codex in ChatGPT's browser**
(the browser inside the ChatGPT app) and **Codex in Mac apps** (`agents.codexChrome`,
`agents.codexInAppBrowser`, `agents.codexMacApps`). Each is kept unless you turn it off, and all
three off is the browser not given. For one turned off, Gram turns off its skills plugin in the
thread's config (`chrome@openai-bundled`, `browser@openai-bundled`, `computer-use@openai-bundled`).
Without Mac apps it also sets Codex's own `computer_use.default_app_access` to deny, and with
neither browser, `browser_use.default_origin_policy` to deny. One runtime (`cua_repl`) serves all
three, so with one browser kept, turning the other off takes away its skills and not the runtime.

**Sites and apps.** Two lists in the same group limit what a lent browser may act on: **Allowed
sites** (`agents.browserSites`, each a host such as `github.com`, matched exactly) and **Allowed
Mac apps** (`agents.browserApps`, each a bundle id such as `com.apple.Safari`). Empty means no
limit. For a Codex thread, Gram sets Codex's own policy in the thread's config: every site denied
but the listed ones (`browser_use.default_origin_policy` and `browser_use.origins`), and every app
but the listed ones (`computer_use.default_app_access` and `computer_use.macos.bundle_ids`). A
Claude thread is refused when a Claude in Chrome call opens an address on another site. A link it
clicks on a listed site can still lead elsewhere, so the extension's own site permissions remain
the backstop there. Claude in Chrome reaches no Mac apps.

A workspace can carry lists of its own, under its settings' **More options** (`browserSites` and
`browserApps` in its charter). For that workspace's orchestrator and workers, a list of its own
takes the place of the user-wide one, sites and apps each on their own; left empty, the user-wide
list applies. Only the user edits them: no agent can change either through `settings_propose` or
`workspace_update`.

**Ask before each action.** With **Ask before each action** on (`agents.browserAskEachAction`),
a thread given the browser asks first whatever its workspace's gate. A Claude thread asks before
each Claude in Chrome call that acts (reads such as `read_page` don't ask), as it already does
under a workspace that asks before anything leaves the machine. For Codex, and for the extension's
own prompts on Claude, a permission prompt card then offers only a one-time yes.

**Permission prompts.** When a computer-use or other MCP server asks a yes-or-no question
before it acts ("Allow ChatGPT to use Safari?"), the thread shows it as an approval card. A Codex
thread's card offers this session or always only where the server offers them. A Claude thread's
offers this session, which Gram remembers for that session by server and message, since Claude
Code passes on no grant of its own. Under an outward gate that asks about everything, either
card is for the one use. A prompt that needs more than a yes or no (a form's own fields, a link,
a verification) is declined with a notice.

**A broken `computer-use` server.** An old copy of Codex's standalone computer-use client in
Claude Code's config has a relative command (`./Codex Computer Use.app/…`). Claude Code starts
every stdio server in the session's folder, so that command fails with ENOENT in every Claude
session. Even started by its full path, the standalone client times out at bootstrap without the
Codex app's service, so remove it (`claude mcp remove <name> -s user`); Claude threads use Claude in
Chrome. Settings → Connectors' copy to another agent now makes a command relative to an absolute
`cwd` absolute, and asks for the full path when there's no absolute `cwd` to go by.

Notifications retain sanitized history and quiet startup diagnostics; saved
notifications omit sensitive runtime details. Dictation is off until turned on in Settings → Voice
(stored as `experimental.voiceInput`, its name before it graduated). It runs locally with NVIDIA
Nemotron through sherpa-onnx, after explicit verified-download/license consent and
microphone permission, and inserts draft text only. English is supported. The microphone opens on
a press and closes with its stop, unless the opt-in Keep microphone ready holds it for 2 minutes
after a composer's focus or the last dictation, with the moments before a press in memory only.
Its key is Right ⌥ held on macOS and Ctrl+Shift+Space elsewhere, rebindable on the Voice page or in
Settings → Keyboard (one binding in `keybindings.json`) to a chord or one modifier held alone, Fn
included where the app sees it. Held alone, it works anywhere in the window and dictates into
the composer in use: a tap or a press with another key discards silently, and a double tap keeps
listening until the next press. Synthesised tones mark the start and the stop.
In Accurate mode (the default where the models are downloaded) each pause also runs NVIDIA
Parakeet TDT over the utterance, its silence trimmed by Silero VAD, and commits that text with
punctuation in place of the live words; Live commits the streaming text alone.
Each committed utterance, never the live words, is then cleaned up, with a switch per rule on the
Voice input page, all on by default: filler words such as "um" and "uh" leave, "new line" and "new
paragraph" become line breaks, and spoken symbols become characters ("foo underscore bar" is
`foo_bar`, "src slash index dot ts" is `src/index.ts`). After "a" or "the" a symbol's word stays a
word, and "literal" before one keeps it as spoken.
Committed text then spells names the way the code does: with Use this project's names on (the
default), "use dictation dot ts" becomes `use-dictation.ts`, from the thread's tracked file and
folder names, exported symbols, branches and thread titles, read from git on this computer, capped
at 3,000 and read again when the commit or index changes. Settings → Voice → Your words adds
the user's own terms with "sounds like" spellings. Names made only of everyday words, and single
common words, are never replaced unless listed as a spelling.
Native loading does not prove
microphone or recognition quality; see [verification](VERIFICATION.md#manual-provider-and-dictation-checks).

Source: [browser bridge](../packages/server/src/browser),
[notifications](../apps/web/src/stores/notifications.ts),
[speech module](../packages/shell/src/modules/speech).
