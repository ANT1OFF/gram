# Move a thread to a server, and bring it back: handoff

## Target

`v3.html`. The build matches these boards and states:

- **1 Move a thread**: `menu`, `unavailable`, `review`, `warnings`, `blocked`, `moving`, `failed`, `moved`.
- **2 Bring it back**: `review`, `folder`, `off`, `back`.
- **3 A sent worker's approval**: `approval`, `question`.

All of it sits behind the hosted-features setting and needs a server signed in to
([hosted-device](../hosted-device/handoff.md)).

## Decisions

- A thread has one home at a time. The side it left keeps a read-only copy; nothing is deleted.
- What goes: the conversation, the agent's session, its edits (tracked and untracked, gitignore
  honoured) on the hidden ref `refs/gram/wip/<thread>`, never on the branch, and the branch.
- What never goes: sign-ins, keys, ignored files, this machine's hooks and MCP servers, terminals.
- Anything that looks like a key, in messages, the session or the edits, goes as `[removed]`.
- A running turn ends first; "Stop and move" cuts it short and the thread is told.
- The receiving side's rules apply from the move on: its model account and allowed models, its
  autonomy limit, its audit, which marks the conversation as brought in.
- Bringing work back is the receiving organisation's choice. Refused, the item is greyed with the
  reason, as Continue in is, and "New thread here from <branch>" is offered.
- Local changes made since the move are put aside on a branch of their own before the edits land.
- An open approval: bringing back waits for it by default.
- A sent worker's approval is decided on the server only; its questions are answered here.

## Parts

| In the mock | In the build |
| --- | --- |
| Menu item, greyed with `.why` | `thread-menu.tsx`, as "Continue in…" is greyed with its reason |
| `.sm-sheet` | A dialog beside `MoveWorkspaceDialog` (`orchestration/move-workspace.tsx`) |
| `.sm-checks` | The checks list that dialog already draws |
| `.sm-progress` | The move dialog's progress |
| `.callout` | `alert` |
| `.sm-ask` | The question card a worker's ask draws |

## Deviations allowed

Real names, counts and sizes; "this Mac" becomes "this computer" off macOS.
Not allowed without asking: sending edits on the branch, sending ignored files, deleting anything on
either side, bringing back while an approval is open without saying it is cancelled.
