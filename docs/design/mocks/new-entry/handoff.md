# New entry points: handoff

[Brief](brief.md) · [Decisions](decisions.md) · [Approved page](v1.html)

## Target

`v1.html`, direction **A Menu** (board `#a-menu`). The build must match its states:

- **menu**: the overview header's `+` (after Hide sidebar, Usage, Settings and Compact overview)
  opens a menu with, in order:
  - "Task for <workspace>'s orchestrator" with ⌘N and a Send to submenu of the workspaces, the
    default one ticked;
  - "Worker in <workspace>" with ⌥⌘N and the same submenu;
  - "One-off thread" with ⌘T;
  - a separator, then "New workspace…".
- **orchestrator**: New task, its target chip naming the orchestrator, without the "who picks it
  up" radio.
- **worker**: the same page started straight to a worker: "Worker in <workspace>", the repo line
  and Start worker.
- **one-off**: today's `/new` draft.
- **workspace**: today's `/new-workspace` sheet.

## Decisions

- A Menu was picked; B Composer, C Split and D Rows are dropped.
- The default workspace is the open thread's, else the last one used (`defaultTaskTarget`).
- The remembered choice is the row the menu opens on: the board's note says "the last one used is
  focused". A plain click on `+` opens the menu with that row highlighted, so Enter repeats it;
  ⌘N, ⌥⌘N and ⌘T go straight to their screens without the menu. Only a pick in the menu is
  remembered.
- ⌥⌘N is free in `keyboard/catalog.ts` and is the worker's shortcut. New workspace gets none.
- New task loses its radio; the way comes from the entry (`/new-task`, `/new-task?way=direct`), and
  a pick from Send to adds `workspace=<id>`.

## Parts

| Mock                            | Code                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `.btn.sm.ghost.icon` (`+`)      | `components/ui/button` as the Base UI `Menu.Trigger`                              |
| `.pop[role=menu]`, `.menu-item` | Base UI `Menu` in `orchestration/new-entry-menu.tsx`, as `context-menu` styles it |
| Submenu "Send to", `.grp`       | `Menu.SubmenuRoot` with a `Menu.GroupLabel`                                       |
| `.kbd`                          | the catalog's hints through `useShortcutHint`                                     |
| `title=` hints                  | `title` on the trigger and on truncated labels                                    |
| Landing screens                 | the existing `/new-task`, `/new` and `/new-workspace` routes                      |

Nothing in the board needs a new component.

## Deviations allowed

- Real workspace names: long ones truncate, with the full label on hover; the menu is 320 px.
- Platform shortcut glyphs follow `keybindings.json` overrides.
- Not allowed: the order of the rows, the separator before New workspace, the submenu on both the
  task and the worker, or a `+` that skips the menu.

## Gaps

- `[Your last message]`, `[Gram's orchestrator thread]`, `[model]`, `[Effort]`, `[Repository]` and
  `[Solo thread]` are filled by the real screens' data.
- The compact rail (60 px) and the Quiet view's menu keep their own entries (out of scope).
