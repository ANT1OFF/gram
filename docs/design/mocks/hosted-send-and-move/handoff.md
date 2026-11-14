# Send work to a hosted workspace, and move a workspace there: handoff

## Target

`v1.html`, approved 13 November 2026. The build matches these boards and states:

- **1 Send a task**: `pick`, `ready`, `blocked`.
- **2 A sent worker**: `running`, `asks`, `signed-out`.
- **3 Move a workspace**: `review`, `moving`, `moved`.

All of it sits behind the hosted-features setting, and needs a server signed in to
([hosted-device](../hosted-device/handoff.md)).

## Decisions

- A sent worker is a thread of the hosted workspace. It runs there under that server's rules and
  reports to the orchestrator that sent it. This Gram holds none of its files.
- Hosted workspaces are listed in the Machine menu under their server, after this machine and
  joined machines. One the organisation closed to sent work is listed and off, with the reason.
- Three checks before sending, each said plainly: the server reaches the repository, the base
  branch is pushed, uncommitted changes stay here. The first two block; the third only warns.
- The orchestrator may send work to a server only when the workspace's settings allow it.
- A workspace has one home at a time. After a move it is archived here, never deleted.

## Parts

| In the mock                    | In the build                                                                |
| ------------------------------ | --------------------------------------------------------------------------- |
| `.sm-chip`, `.sm-menu`         | The Machine picker in New task (`composer/new-task-draft.tsx`) and its menu |
| `.sm-line`                     | The line under Where it runs                                                |
| `.sm-checks`                   | New: a checks list; rows as in Settings → Machines                          |
| `.sm-row` with the server mark | The machine mark where a thread is listed (sidebar, Workers, Board, Inbox)  |
| `.badge.info`, `.callout`      | `badge`, `alert`                                                            |
| `.sm-ask`                      | The question card a worker's ask already draws                              |
| `.sm-sheet`                    | A dialog, as Remove workspace's                                             |
| `.sm-progress`                 | New: no progress bar in the kit yet                                         |

## Deviations allowed

Real names, counts and sizes; "this Mac" becomes "this computer" off macOS; platform key hints.
Not allowed without asking: dropping a check, sending while a blocking check fails, or deleting
anything local on a move.

## Gaps

- `[Your name]`: the person's name as the server gives it.
- "Ask for access" opens an address the server supplies; none is defined yet.
- Copy settings and memory, and Bring back, are named and not drawn.

## Built so far

Board 3, the move, is built as `MoveWorkspaceDialog` (`apps/web/src/orchestration/move-workspace.tsx`),
opened from a workspace's menu as "Move to a server…". It is offered only in the desktop app, with
the hosted features on and a server signed in to, and only where the shell has the calls that move
one (`hostedDevice.move` in `packages/contracts/src/desktop-bridge.ts`): `check`, `start`, `cancel`
and `onProgress`. The sheet draws what those calls answer and decides nothing itself.

Still to come, each a change of its own:

- The shell's side of `hostedDevice.move`, and the address on a hosted server that takes a bundle.
  Until then no shell offers the calls, so the menu item does not show.
- "Archived here as Moved to …": a workspace has no archived state yet, so the sheet says it is
  kept here, paused, which is what an export does today.
- The counts of messages and routines under Goes, "Ask for access", Copy settings and memory, and
  Bring back.
