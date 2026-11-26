# Coordinate workers and wakes

How an orchestrator cuts work into workers and follows them, and how any Gram thread waits without
polling. Agents read this with `read_playbook` (`coordinate-workers-and-wakes`). Each tool's
description and the role instructions still hold the rules, effects and approvals, and those win
wherever this page is shorter.

## Choose the worker

- **Look for a live owner first.** A follow-up or fix on a live worker's feature goes to that worker
  with `send_message`. Once a feature has merged, more work is a new worker. Separate asks in one
  message usually get a feature each.
- **A thread already doing the work** (the user started it elsewhere, or it is another workspace's
  worker) can be taken on with `adopt_thread`. It asks the user, and arrives unbriefed: read it with
  `get_thread` before you message it.
- **`spawn_task` is not a worker.** Use it only for work that belongs outside the workspace, with a
  `reason`.
- **One worker across repos** (`project`, plus the others in `alsoIn`) when the change is one piece of
  thinking: the repos must agree on something, or the edits elsewhere are small (a registration, a
  config entry, a version bump, generated code). Put the substance in `project`: rewind, the per-turn
  diff and the review monitor follow the first repo only.
- **One worker per repo** under the same `feature` when the pieces are big enough to run side by side,
  can be reviewed and merged alone, or one side's contract should settle first. Brief the providing
  side first, or write the contract into every brief.
- **A running worker that turns out to need another repo** gets it with `add_worker_repo`, not a second
  worker.
- **A repo outside the workspace** can be named by its project name, or by the absolute path of a git
  repository's top folder. The call asks the user to add it. If they decline, carry on without it.

## Write the spawn

- **The brief stands alone:** the goal, the invariants, the constraints, what done looks like, the
  files or interfaces that matter, and how to verify. Attach the user's words with `userMessages`
  rather than retyping a paste. Give the brief's checklist as `plan`.
- **The title** is 2–5 words that keep the bug, system or feature and tell review from
  implementation: "Review browser safety", "Fix browser safety". Not "Fix bug", and not a sentence cut
  short.
- **The model** matches the brief to the `useFor` notes in `list_workers`' `workerModels`. A full
  credit window is no reason to avoid an agent's models. When a worker's checks keep failing, spawn
  again one `effort` level up (never past `high`), then the next tier.
- **`priority: "low"`** is for chores, follow-ups and nice-to-haves, never what the user is waiting
  on.
- **`scope`** lists the paths it will touch, so an overlap with a live worker comes back as a warning.
  **`clientRequestId`** makes a retried call return the worker it already made.
- **A reviewer** gets `base` set to the author's branch, its own `branch`, and `readAlso` with the
  author. Brief it to read and review only, and to `send_message` its findings with a score to the
  author. A council is up to three reviewers on different harnesses or tiers, never two on one model.

## Place it

Where `sandbox` is offered (`worker_machines` shows each machine, its room and who is on it):

| The work                                                                                          | `sandbox`                                                                     |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A large build, a long test suite, tests on the other processor                                    | `{own: true}`, with the size, architecture, isolation or environment it needs |
| Reads what outsiders wrote (web pages, other people's issues or pull requests), or holds a secret | `{own: true, exclusive: true}`                                                |
| Light work that should start in seconds                                                           | `{shared: true}`                                                              |
| A reviewer that reads its author's worktree                                                       | `{shareWith: "<author's threadId>"}`                                          |
| Nothing heavy                                                                                     | `{own: false}`, your machine                                                  |

Give `reason` in one sentence: the user reads it on the worker's row. Workers on one machine can read
each other's files and share its memory and ports. Over your total, the `over_total` refusal says what
is in use and what you can do.

## When a spawn doesn't start

- **`held: true`**: a subscription limit, the user's pause threshold, or a recent auth, model or network
  failure holds the brief. It is listed under `list_workers`' `held`. Cancel or retarget it with
  `manage_held_spawn`.
- **`routeOffer: true`**: the model you named is at a limit and others are clear. Pick one of
  `alternatives` whose note fits the brief and call again with that `model`, or with `atLimit: "stay"`
  to keep yours. Tell the user which model the worker runs on and why.
- **A model marked unavailable** starts on the default instead, and the result says so. Tell the user.
- **Orchestration is paused**: the call is refused. Don't retry in a loop. Running workers carry on.

## Read reports and the ledger

- **A report is its worker's word** until you have looked. `done` carries a pull request and the
  worker's evidence (`headSha`, its gate, `nextStep`): check the pull request and its checks before
  you tell the user. `blocked` says what stops it: resolve what is within your authority, else take it
  to the user. `learned` goes into memory only if it holds for later work and is new.
- **`list_workers` is the ledger.** Call it before you tell the user where things stand. Rows are
  compact; `detail: true` adds the whole last report with its interface, the activity line, context
  use and the messages you sent. Narrow it with `live: true` (those that count against the cap),
  `state`, `since` or `includeArchived`.
- **A row** gives the worker's state and status, project, machine (`online`, its `packing`,
  `sharesWith`), branch and pull requests, the start of its last report, pending requests (each
  `requestId` and what it asks), overlaps, changed files, and cost only on a gateway. What is empty is
  left out. `app` is the running Gram's version, to tell whether a merged fix is live yet.
- **`delivered`** means pushed or finished in a repo with no pull requests, not merged. A worker with
  several pull requests is merged only once none of them is open.
- Link a thread for the user as `[title](#threadId)`.

## Choose a monitor or a wake

Never sleep or poll inside a turn. Pick what wakes you, then end the turn:

| Waiting for                                                                | Use                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------- |
| Your own pull request's checks, review or merge state                      | `pr_review_monitor` (`pr_monitor` for CI alone) |
| A pull request yours can't merge before                                    | `depends_on`                                    |
| An Actions run that belongs to no pull request                             | `run_monitor`                                   |
| Another pull request merging, closing, getting a push or a verdict         | `schedule_wake` with `onPr` and `on`            |
| A branch's new head                                                        | `schedule_wake` condition `branchMoved`         |
| A worker, or a research or review thread, finishing without a pull request | condition `threadFinished`                      |
| A job queued with no runner, or a run awaiting approval                    | condition `ciStuck`                             |
| A machine going quiet, or its disk filling                                 | condition `machine`                             |
| A merge freeze ending                                                      | condition `freezeLifted`                        |
| A release reaching an age (npm or GitHub)                                  | condition `releasePublished`                    |
| An installed CLI or app changing version                                   | condition `versionChanged`                      |
| A time (a canary window, "tomorrow morning")                               | `schedule_wake` with `inMinutes` or `at`        |

- With `onPr` or a `condition`, the time is only the fallback. Never wait for another pull request on
  a timed wake alone: nothing would notice when the wait stops making sense.
- Write the `note` as what to do then, not "check": "Canary at 45 minutes: compare its error rate with
  the baseline; roll back if it doubled."
- For example, to wait for a dependency's release to age three days on npm:
  `condition: {kind: "releasePublished", source: "npm", name: "<package>", after: "<current version>", minAgeDays: 3}`.
  The result's `when` spells out what was armed, with its defaults.
- An orchestrator can brief a worker to set its own wake rather than sleep. A parked thread or a
  paused workspace holds a wake, closing the thread drops it, and an archived worker isn't woken.

## Recover and hand off

- **A worker looks stuck or idle**: read its row with `detail: true`, or the thread with `get_thread`.
  Then `send_message` what changes its work. Steer is the default; `mode: "queue"` is for what changes
  nothing it does now; `mode: "interrupt"` is for an urgent stop only. `stop_thread` stops its turn.
- **`main` moved, or a convention changed**: `broadcast_message` once, not a send to each worker.
- **Its worktree is missing**: `restore_worktree` recreates it from the branch. What was uncommitted is
  gone. If the branch is gone everywhere, `fromPr: true` recreates it from its pull request's head. The
  thread is cold afterwards: message it to carry on.
- **Its setup changed** (settings, MCP servers, CLAUDE.md or AGENTS.md, skills): `restart_session`.
- **The wrong model**: `set_thread_model`, which the user approves.
- **Handing work on**: the old worker commits and pushes its branch and reports where it stopped
  (`nextStep`). Spawn the new one with `base` set to that branch and its own `branch`, briefed with
  what the report says is left.
- **Archive** a worker whose work merged or was delivered once it waits on nothing. Keep one with a
  wake pending or a next pull request to open. Archiving one with an open or monitored pull request is
  refused unless `force`.
- **As a worker**: when you can't continue, `report` `blocked` with what you tried and ruled out. To
  settle a conflict with a sibling, `send_message` it by its full `threadId`. After a restart, check
  your worktree, git history and GitHub before you repeat a push, a pull request or a comment.
