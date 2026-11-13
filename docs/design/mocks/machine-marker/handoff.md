# Machine marker: handoff

[Brief](brief.md) · [Decisions](decisions.md) · [Approved page](v1.html)

## Target

`v1.html`, direction **B Edge label**. The build must match this board:

- **B Edge label**, every part of it:
  - the sidebar: a worker or solo row on another machine has the server glyph and the machine's
    name at its edge; the glyph alone where the edge has words of its own ("checks", "asks you");
    the struck glyph and "offline" for a machine nothing reaches; nothing for a thread on this
    machine;
  - the thread header: the glyph, the name, "offline" when it is, and the folder there;
  - the Board: the glyph and name under the task's title;
  - the feature card: the glyph and name at the end of a worker's line;
  - the Workers tab: after the status, set off by a middle dot;
  - the Inbox: after where the item is from;
  - the hover: "Runs on atlas", then "Joined machine · online for 2 hours"; offline, also why and
    the fix.

A Glyph and C Chip are dropped.

## Decisions

The lines of [decisions.md](decisions.md) all hold: B was picked, offline is neutral, and the build's
deviations are listed there.

## Parts

| In the mock                | In the build                                                           |
| -------------------------- | ---------------------------------------------------------------------- |
| `.mk` (glyph, name, state) | New: `MachineMarker` in `apps/web/src/thread/machine-marker.tsx`       |
| `#srv`, `#srv-off` glyphs  | Lucide `Server` and `ServerOff`, `size-icon-chip`                      |
| `.mk.off` (text colour)    | `text-foreground` on the marker; no status colour                      |
| `title=` on a marker       | `Hint` (`components/hint.tsx`); a native title inside a titled row     |
| `.tip` (the hover's lines) | `machineMark().hint` in `thread/machine-mark.ts`, from `machineHealth` |
| `.sb-row .tail`            | `ROW_TRAIL` in `orchestration/overview-section.tsx`                    |
| `.hd .mk` with `.path`     | `MachineChip` in `thread/machine-chip.tsx`                             |
| `.bd-task .under`          | The task cell's meta line and `SubTask` in `views/board-grid.tsx`      |
| `.fc-w`                    | `WorkerLine` and `CalmFeatureLine` in `orchestration/feature-card.tsx` |
| `.wk-s`                    | `ROW_STATUS` in `orchestration/workers-panel.tsx`                      |
| `.ib .ctx`                 | `InboxRow` in `inbox/inbox-body.tsx`                                   |

Data: the server sends `machines.snapshot` on `events.subscribe` and on every change; the web keeps
it in `stores/machines.ts`. A thread's machine is its checkout's `hostId`.

## Deviations allowed

- Real lengths: a long machine name is cut with an ellipsis; a row's title still wins the room.
- Where the mock's row edge and the app's differ (a wait's glyph and PR number instead of
  "checks"), the marker follows the rule, not the picture: words at the edge mean the glyph alone.
- Not allowed: a chip, a pill or a status colour on the marker; a marker on a thread that runs on
  this machine; an offline state that needs a hover to see.

## Gaps

- `gram#[n]` on the Board is a placeholder for a real PR chip, which the build leaves as it is.
- `[its question]` in the Inbox is the item's own title.
