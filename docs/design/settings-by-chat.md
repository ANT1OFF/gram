# Settings by chat

[Up: docs](../README.md) · [Agents and features](../AGENTS_AND_FEATURES.md) ·
[Architecture](../ARCHITECTURE.md)

Gram's agents can read Gram's settings and propose changes to them through the gram MCP
server (`mcp__gram__*`) that every thread already has. They can also propose new workspaces
and changes to a workspace's projects, home, autonomy and worker mode. The user approves every
change on a card in the thread, which shows the change as before → after. Nothing is applied
until the user approves it. Some settings an agent can never change, even with the user's
approval: they stay in the Settings UI.

## Tools

| Tool               | Class                              | Audience                    | What it does                                                            |
| ------------------ | ---------------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `settings_read`    | read                               | orchestrator, plain, worker | The settings in the caller's scope, with their current values and tiers |
| `settings_propose` | outwardGated (raises its own card) | orchestrator, plain         | Validates a change set, shows the card, applies the change on Apply     |
| `workspace_list`   | read                               | orchestrator, plain         | The workspaces in scope, with their projects, autonomy and settings     |
| `workspace_create` | outwardGated (raises its own card) | orchestrator, plain         | Validates a new workspace, shows it whole, creates it on approval       |
| `workspace_update` | outwardGated (raises its own card) | orchestrator, plain         | Validates a workspace change, shows it whole, applies it on approval    |

There is no separate `apply` tool. `settings_propose` and the workspace tools wait for the
user's answer and then apply the change in the same call. A separate apply verb would give the agent something it
could call with a stale, guessed or replayed proposal id. With one call, the agent never holds
a capability to apply anything: the commit point is the user's click.

### `settings_read`

Input: `{ workspaceId?: string, projectId?: string }`. The result:

- `project`: the project in scope (the thread's own, or one of its workspace's projects named
  by id or name in `projectId`), with its local check `command`, `setup` and `timeoutMs`. Without
  a command the local gate is off.

- `app`: each app key in the catalogue below, with `{ key, label, tier, value }`. `value` is
  the stored value, or the effective default when nothing is stored. User-only keys are
  readable where the value is harmless to show (autonomy, permission modes, usage-history
  and update opt-ins). For the rest, such as folders, commands, connectors and gateways, only
  the key's name is returned, without a value.
- `workspace` (when the caller has one): its name and id, then the same rows for the charter:
  max concurrent workers, the pause threshold, the merge review policy, the automatic Dream
  threshold, the orchestrator's model and effort, and `workerModels`, which lists
  `agent:model`, `useFor`, `default` and availability (`unavailable`, the same reason
  `list_workers` gives).
- `userOnly`: every never-settable key, with why it is user-only. Whether the workspace is
  paused is read here.
- `howToChange`: one line on `settings_propose`.

**Redaction.** The read is built from the catalogue, never by dumping `Settings`. Keys that
aren't in the catalogue don't appear at all. Gateway profiles, keys, vault info, base URLs,
credential paths, MCP server configs and connector lists are never read. Model refs keep
their `profileId`, because a worker model is matched by it, but that is an opaque id, not a
URL or a key.

**Scope.** The workspace in scope is the caller's own: an orchestrator's or a worker's
workspace, or the one a plain thread joined. A plain thread may name another workspace with
`workspaceId`, because the user is chatting with it directly and approves every change.
An orchestrator or a worker that names a workspace other than its own is refused.

### `settings_propose`

Input:

```json
{
  "reason": "You asked for a cheaper reviewer.",
  "workspaceId": "optional, plain threads only",
  "projectId": "optional, a project in the thread's workspace",
  "changes": [
    { "op": "set", "key": "workspace.maxConcurrentWorkers", "value": 6 },
    {
      "op": "add",
      "key": "workspace.workerModels",
      "item": { "agent": "claude", "model": "sonnet", "variant": "high", "useFor": "reviews" }
    },
    {
      "op": "update",
      "key": "workspace.workerModels",
      "match": "claude:haiku",
      "item": { "useFor": "docs only" }
    },
    { "op": "remove", "key": "workspace.workerModels", "match": "codex:gpt-6.1-sol" }
  ]
}
```

- `set` sets a key. `value: null` clears an optional key back to its default.
- `add`, `remove` and `update` work on list keys (`workspace.workerModels`,
  `agents.workerModels`). `match` is `agent:model`, or `agent:model@profileId` when two
  entries share a model. An ambiguous or unknown match is refused.
  - `update` may change `useFor`, `default`, `variant` and `speed`. To change the agent, model
    or profile, remove the entry and add a new one.
  - Marking an entry `default` clears the mark from the others.
  - Removing the last workspace worker model clears the roster, so workers run on the
    orchestrator's own model, as the Settings UI does. An empty list would let no worker spawn
    at all.
- An item may not carry a `profileId`. Choosing which gateway profile, and so which key, a
  worker runs on is the user's, in Settings.
- `workspace.orchestratorEffort` sets the effort only on a model the workspace pins itself.
  On an inherited one, it is refused: setting it would quietly pin the app's default model, and
  it would depend on an app setting the card can't hold still. Set
  `workspace.orchestratorModel` with a variant instead.

**One scope per change set.** A change set touches app settings, one workspace or one project.
So applying it is one transaction: on the settings row, one workspace row or one project row.

**The plan is a set of field writes.** Planning turns the change set into writes: each stored
field it changes (`appearance.mode`, a charter field such as `workerModels` or
`orchestratorModel`), with its value as stored before and after. The card's
rows are drawn from these writes, never from the change set's words. Each write gets at least
one row, so:

- an explicit `standard` speed is shown, which differs from an inherited speed;
- a value written over its default shows `off (default)` → `off`;
- an effort change shows the whole model it is stored on;
- a worker-model list shows a row for each entry that changes. It also shows an order row
  when kept entries change places, beside any other row. And it shows a "worker model used
  when none is named" row when the fallback changes. That fallback is worked out by the same
  rule `spawn_worker` uses (`workerFallback` in contracts), for the orchestrator's current
  model. A list that holds one model twice is shown whole.

**What a card reads, it holds.** Clearing `workspace.orchestratorModel`, or setting it where it
was inherited, reads as the app's default model, for example `claude:fake-haiku (default)`.
The plan records that dependency (`requires`), and the workspace transaction checks it against
the app settings it reads in the same transaction. If the default has changed, nothing is
written. The fallback row is the one exception: it depends on the running orchestrator's model,
which no setting holds, so it describes the moment of the card and isn't bound.

The audit records the same writes, typed.

**Validation, before any card.** Every change is checked against the catalogue: the key is
listed, the op fits the key, and the tier allows it. The result is then decoded against the
schema the Settings UI writes through:

- `SettingsPatch` for app keys;
- `OrchestratorCharter` for workspace keys, plus `setCharter`'s own checks at apply
  time, such as whether the orchestrator's agent may orchestrate.

A proposed model id is checked against the models its agent lists. When the agent can't list
its models, the card says so instead. A change that changes nothing is refused. Errors name
the key and the reason.

**The card.** It uses the existing server approval plumbing (`ThreadRuntimes.requestApproval`):
the request shows in the thread, Needs you and the desktop ask stack like any other approval.
Its input is a typed `SettingsProposalCard`, with the scope, the workspace's id and name,
the agent's reason, and the rows: a label, and before and after as readable text. The web renders it
as a diff table, open from the start.

- The card is `mustReadDetails`, so it is never folded into "Allow all" or answered in place
  from the ask stack, and an away notification never answers it.
- Its only scope is `once`.
- Its buttons are **Apply changes** and **Deny**.

**Outcomes reported to the agent.**

- Applied: `{ applied: true, changes, auditSeq, note }`. The note says when a change takes
  effect later, for example that the orchestrator model applies to the next orchestrator
  session.
- Denied: an `AppToolError` saying "The user declined the settings change; nothing changed."
- Expired: after `SETTINGS_PROPOSAL_TTL` (15 minutes) the card is withdrawn and the call fails
  with "expired … nothing changed; propose again if it is still wanted". It also ends when the
  turn or session ends, as every server card does.
- Moved: if a written field no longer holds its _before_ when the write runs, nothing is
  applied, nothing is audited, and the agent is told to propose again. The same happens if the
  caller's role, or an orchestrator's workspace, has changed. The user then approves a diff
  that is true.

**Applying** writes exactly what the card showed, to exactly the target it named:

- **The target is pinned by id when the change is proposed.** A rename, another workspace
  taking the name, or a change in the caller's membership never moves the approval elsewhere.
  The planned writes are applied as they are; nothing is planned or resolved again after the
  answer.
- **Each write is a compare-and-swap inside one database transaction.** The transaction reads
  the row as stored then, checks that every written field still holds its _before_, writes
  only those fields, and inserts the audit row. Fields the change doesn't name, such as
  autonomy, the worker mode or connectors, keep whatever they hold at that moment; they're
  never written back from an older read. If any check fails, nothing is written, the audit
  row included. A stored change therefore always has its audit, even through a crash or a
  cancelled call.
- **The paths are the Settings UI's own.**
  - App keys go through the writer behind `settings.set` (`settings/writer.ts`, shared by the
    RPC and the tool). Its post-commit effects, the same as the UI's, are the log level, the
    update prefs mirror, Dreams and the orchestration lifecycle. It then publishes
    `settings.changed`, and every window pulls the server's settings.
  - Charter keys go through `Orchestration.changeCharter`. That is `setCharter`'s own write
    path, with its checks under the same lock, its roster note to the orchestrator and its
    session reloads. Only its commit differs: the compare-and-swap above.
- The commit and its effects aren't interrupted once begun.

### Workspaces: `workspace_list`, `workspace_create` and `workspace_update`

Which repos a workspace reaches (`workspace.projectIds`, `workspace.homeProjectId`), its
autonomy and its worker mode decide what its agents reach and may do without asking. So they
are never a settings change: `settings_propose` refuses them and points to `workspace_update`.
The workspace tools change them only on a card of their own, which shows the whole workspace.

`workspace_list` takes `{ workspaceId?: string }`. For each workspace in scope it returns the
id and name, the projects with their id, name and absolute root, the home project, autonomy,
worker mode, the orchestrator's thread when one is open, the pause reason when paused, and the
charter rows `settings_read` shows. A plain thread sees every workspace; an orchestrator its
own.

`workspace_create` takes:

```json
{
  "name": "Platform",
  "projects": ["/absolute/path/to/repo-a", "/absolute/path/to/repo-b"],
  "home": "/absolute/path/to/repo-a",
  "autonomy": "publish",
  "workerMode": "auto",
  "settings": [{ "op": "set", "key": "workspace.maxConcurrentWorkers", "value": 4 }],
  "openOrchestrator": true,
  "reason": "The handoff README lists this workspace."
}
```

`workspace_update` takes `workspaceId` (an id or a name; an orchestrator's own by default),
and any of `name`, `addProjects`, `removeProjects` (a path or a project id), `home` (a path or
a project id), `autonomy`, `workerMode` (`null` follows the default again) and `settings`.

- **A project is a canonical folder, and the approval grants folders.** Each project path
  must be absolute, exist, and already be its own real path: a path with a link anywhere in it
  is refused, with "use the real folder: <real path>". That folder's own `.git` must be a
  folder, not a linked worktree's or a submodule's file, and `git rev-parse --show-toplevel`
  must name the folder itself. A subfolder, a linked worktree, a plain folder, a folder with an
  empty or broken `.git`, a link and a missing path are refused before any card, with the
  reason. A project Gram already knows is used only when its stored root passes the same rule,
  so one stored at a link is refused too. Gram registers the path the card shows, and a
  repository it doesn't know yet is registered only once the user approves. Approval grants
  the folder, not the repository in it: if what the folder holds is replaced, it is the same
  grant, since an agent that can write there could change it anyway.
- **The card shows the whole change.** A new workspace's card lists its name, each project path
  (the home and any new to Gram marked), autonomy, worker mode, every charter field the new
  workspace stores, and whether its orchestrator opens. An update's card lists each project as
  kept, removed or added, then name, home, autonomy, worker mode and charter changes before →
  after. Its input is a typed `WorkspaceProposalCard`.
- **Validation.** Names are unique, ignoring case and spacing. The home must be one of the
  projects after the change, and a workspace keeps at least one project. `workerMode` is one of
  the modes Settings offers: `auto`, `acceptEdits`, `default` or `bypassPermissions`.
  `settings` takes `settings_propose`'s changes on `workspace.*` keys only, planned and
  checked the same way, models included. The home can't move while the workspace's
  orchestrator is open, since it works there; that is refused before any card.
- **One card per call, the same plumbing.** The card is raised by the tool's own handler
  through `ThreadRuntimes.requestApproval`, with `once` as its only scope and no rule to
  remember. It is `mustReadDetails`, so it is never folded into "Allow all", answered in place
  from the ask stack or answered from a notification. Its buttons are **Create workspace** or
  **Apply changes**, and **Deny**. Denied, expired or withdrawn, nothing changes.
- **Applying: all of it or nothing.** The handler keeps the workspace exactly as it read it
  for the card: name, projects, home and the whole charter, autonomy and worker mode
  included. After the user approves:
  1. Every folder the card takes in that Gram doesn't know yet is checked again by the same
     rule. One that is gone, or no longer a canonical repository top folder, refuses the
     change.
  2. `Orchestration.commitWorkspace` runs `saveWorkspace`'s and `setCharter`'s checks under
     their locks: a unique name, a home among the projects, no home move while the orchestrator
     is open, an orchestrator model that may orchestrate, no lower autonomy a held thread
     couldn't open under.
  3. One store transaction registers the new repositories as projects and reads the stored
     workspace. It writes the new name, projects, home and charter and the audit row, but only
     if the stored workspace still equals the card's snapshot in every one of those fields and
     the app settings the card read still hold (the app default model, for a cleared
     orchestrator model, on a new workspace as on a changed one), and every project it names
     still exists. Otherwise it rolls back, the projects included, and the agent is told
     nothing changed.

  What a write sets off follows it, as in Settings. A raised autonomy reloads the orchestrator
  and its workers once idle, and the orchestrator's folders follow its projects. Once the
  write has begun, it and what it sets off can't be cancelled, so a call cancelled after the
  commit still takes a removed repository's folder from the orchestrator. The snapshot is
  held by the server; the card's input is only what the user reads, never what is applied.

- **`openOrchestrator`.** With `true`, the new workspace's orchestrator opens once the workspace
  exists, and the result carries its `orchestratorThreadId`, so the caller can message it.

## Approval policy tiers

Enforced by the catalogue in `packages/contracts/src/settings-chat.ts`. A key that isn't
listed is refused as not settable by chat.

### Tier 1 — the running orchestrator or workspace: user approval at every autonomy

`workspace.maxConcurrentWorkers`, `workspace.pauseAtLimitPct`,
`workspace.mergeReviewPolicy`, `workspace.automaticDreamThreshold`,
`workspace.orchestratorModel`, `workspace.orchestratorEffort`, `workspace.workerModels`,
`workspace.workerBriefFooter` (text, `null` or blank clears it), `workspace.routeAtLimit`
(`true`, or `false` to turn it off), and idle compaction's `workspace.idleAutoCompact` and
`workspace.idleAutoCompactKinds`.

The card is raised by the tool's own handler, whichever binding runs it. The gate's
`bypassPermissions` skip, "allow for session" and `delegatedAtFullAutonomy` therefore never
reach it: it asks at `supervised`, `publish` and `full` alike, in every permission mode, and
for each call alone. No orchestrator tool answers an approval or plan card.

### Project — one project's local merge check: approval required

`project.localCheck.command`, `project.localCheck.setup` and `project.localCheck.timeoutMs`.
See [project local merge checks](../AGENTS_AND_FEATURES.md#project-local-merge-checks) for
what they do. They are project settings, not app defaults or workspace charter fields. The
card pins the project id, refuses stale before-values and never changes another project's
command. There is no Settings UI for them.

### Tier 2 — the user's own app preferences: approval required

`appearance.mode`, `appearance.paletteId`, `appearance.density`, `appearance.contrast`,
`appearance.motion`, `appearance.showCost`, `composer.sendKey`, `layout.openAtLaunch`,
`layout.quietWhenIdle`,
`layout.overviewSidebar`, `notifications.native`, `notifications.sounds`,
`notifications.chime`, `notifications.notifyAbout`, `notifications.reviewRequests`,
`notifications.reviewRequestsDirectOnly`, `notifications.reviewRequestsHideBots`,
`notifications.reviewRequestsAwaitChecks`, `updates.channel`, `logLevel`,
`agents.defaultModel`, `agents.idleEvictMinutes`, `agents.followWorktreeMoves`,
`agents.restartOnMcpChange`, `agents.branchPrefix`, `workspaces.localCheckConcurrency`,
`agents.workerModels`.

These need approval too. Letting them apply without a card would be convenient, but Gram
can't tell whether the user is the one asking. A plain thread can read a web page or a file
that asks it to change things, and an orchestrator runs unattended. Each change is small, but
the cost of asking is one click on a card that shows exactly what changes. So in code, tier 2
differs from tier 1 only in its label. (`agents.workerModels` is the roster a _new_ workspace starts with, so it is
an app preference here, not a change to a running workspace.)

### Workspace membership, autonomy and worker mode — only on the workspace card

`workspace.projectIds`, `workspace.homeProjectId`, `workspace.autonomy` and
`workspace.workerMode`. `settings_propose` refuses them and names `workspace_update`, and
`settings_read` lists them with `userOnly` and a `via`. They change only through
`workspace_create` or `workspace_update`, whose card shows the whole workspace change. No
autonomy, permission mode or standing approval answers that card.

### Tier 3 — never settable by an agent, even with approval

Refused before any card is raised. These stay in the Settings UI only:

| Key                                                               | Why it is user-only                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `workspace.paused`                                                | A pause is how the user stops agents, so only the user pauses or resumes |
| `agents.defaultMode`                                              | The permission mode new threads start in                                 |
| `workspace.connectors`, `workspaces.orchestratorConnectors`       | Connectors widen the tools agents get                                    |
| `workspaces.orchestratorPeerMessaging`                            | It lets an orchestrator send to sessions outside Gram                    |
| `agents.defaultFolder`, `agents.cloneFolder`                      | Directories                                                              |
| `agents.codexRuntime`, `editor.command`, `terminal.shell`         | Programs Gram runs                                                       |
| `agents.customModels`                                             | Arbitrary model ids sent as written                                      |
| `helpers.claudeContext`, `helpers.codexContext`                   | Consent for helper context, per provider and scope                       |
| `helpers.source`, `helpers.localFallback`, `profiles`, `gateways` | Gateways and credentials                                                 |
| `updates.automaticChecks`, `updates.pinnedVersion`                | Opt-ins that decide what code Gram installs                              |
| `usageHistory.claude`, `usageHistory.codex`                       | Consent to read local CLI history                                        |
| `workspaces.continueAfterRestart`                                 | Whether agents run unattended                                            |
| `notifications.actions`, `reviewBots`                             | How approvals and merge gates are answered                               |

Each one is tested to be refused. In general, anything that widens an agent's own authority
is tier 3, or is shown whole on the workspace card. Raising `maxConcurrentWorkers` is the
exception: it is tier 1, because it stays within the autonomy the user set.

## Who may call

- **Orchestrators** may read and propose for their own workspace and for app preferences.
  They may propose a new workspace, and changes to their own workspace's projects, home,
  autonomy and worker mode, always on the user's card; never to another workspace.
- **Plain threads** (the user chatting directly) may read and propose for app preferences and
  for the workspace they joined, or another workspace they name. They may list every workspace
  and propose new ones or changes to any.
- **Workers** may read settings only. `settings_propose` and the workspace tools aren't bound
  for them, and each handler checks the caller's audience again at call time, because a Claude
  session keeps its binding through a turn in which its role can change. The reasons:
  - A worker runs unattended on a narrow brief, often in Bypass. Its approval card would sit
    in a thread the user isn't watching.
  - Most of what a worker could propose (more workers, other models, a looser merge policy)
    changes the orchestrator that directs it, and so widens its own authority.
  - A worker that needs a change says so with `report` or `message_orchestrator`. The
    orchestrator proposes it, in the thread the user watches.
- **Dreams** get neither tool.

## Audit

Every applied change is written to `settings_audit`:

- `at`: epoch ms, when it was applied;
- `thread_id` and `proposer_role`: who proposed it;
- `request_id`, `approved_by` (`user`) and `approved_at`, from the approval's resolution;
- `scope` and `workspace_id`;
- `changes`: each stored field written, before and after, typed (`null` for absent);
- `shown`: the rows the card showed;
- `reason`.

A workspace change is also appended to that workspace's `orchestration_events` as
`kind: "settings"`, in the same transaction, so its own audit trail has it. A workspace made
by chat is audited with every field it stores, `before` being `null`. An update writes one row
with every field it changed, in the same transaction as the change. Denials and expiries are logged, but not
written as audit rows, since nothing changed.

## Limits

- The UI's own `settings.set` and `orchestrator.setCharter` keep their last-writer-wins
  behaviour. Only changes by chat compare before they write.
- A workspace change by chat over a workspace edited in Settings since its card is refused
  whole, even when the edit and the change touch different fields. The agent proposes again,
  and the user approves a card drawn from the workspace as it is.
- A change to the orchestrator's model or effort applies to its next session, as in Settings.
  To switch the running one, use the orchestrator switch or `set_thread_model`.
- Synthetic tests run on the fake agent. They don't qualify live Claude or Codex transports.
