# New entry points

Written by the design-brief skill before the first version. Keep it short; it is what the mock is
checked against.

## Problem

The sidebar's one `+` (`overview-sidebar.tsx`, "New task", ⌘N) always opens `/new-task`, the
full-page "New task" form for an orchestrator. The user wants it to be simple to start each of
four things:

1. a new **workspace** (today: the target picker's "New workspace…", the palette, or Settings →
   Workspaces, all leading to `/new-workspace`);
2. a **one-off thread**, outside any workspace (today: ⌘T, the palette, or a footer link under
   the New task form, leading to `/new`);
3. a task **for an orchestrator** to triage (today: `+` → "Orchestrator plans it");
4. a task **straight to a worker** in a workspace (today: `+` → "Straight to a worker", a
   second radio on the same page).

Two of the four hide behind a page built for a third, and nothing at the `+` says which one you
get.

## Who and where

A solo developer with two or more workspaces (Gram, Arb bot) and a few one-off threads, starting
from the sidebar header's `+` at the default 280 px sidebar width, from ⌘N or ⌘T, or from the
command palette (⌘K).

## Must show

Per direction:

- The entry point in the real sidebar header (Hide sidebar, Usage, Settings, Compact overview,
  then the new control), with hover text on every icon.
- All four flows: the entry point opened, and the first screen each one lands on.
- The sidebar as it is: the "Nothing needs you" row, "Orchestrators" with Gram (open, three
  workers) and Arb bot, "Solo threads".
- Real copy from the code where a screen already exists (New workspace's "Repositories" and
  "What should it work on?", New task's "What needs doing", the one-off "What should we build
  in…").
- Shortcuts: ⌘N and ⌘T stay; anything new is marked as a proposal.

## Out of scope

- The fields of each first screen beyond what tells the four apart (agent, effort, autonomy and
  worker fields stay as they are).
- The compact rail (60 px) and the Quiet view's menu.
- The welcome screen and Settings → Workspaces.
- Product code.

## Open questions

Assumptions, each with the default picked:

- **Default target:** the workspace of the open thread, else the last one used, as
  `defaultTaskTarget` does today. Default: kept in every direction.
- **Remembered choice:** the last of the four you used becomes the `+`'s plain-click action only
  in the direction that says so (A); the others keep `+` fixed. Default: A remembers, B to D
  don't.
- **Worker repo:** a direct worker in a workspace with several repos asks which repo, as the
  "in [repo] on a new branch" line does today. Default: shown as that line.
- **New shortcuts:** ⌘⇧N is taken (New window). A direct worker proposes ⌥⌘N; a new workspace
  gets none. Default: placeholders until checked against `keyboard/catalog.ts`.
- **Width:** each control must fit the 280 px header next to the four existing icons and hold at
  the 180 px minimum. Default: icons only in the header, words in menus and hover text.
