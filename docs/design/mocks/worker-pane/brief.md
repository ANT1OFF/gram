# Worker pane: list and worker on the right

Written by the design-brief skill before the first version. It follows
[workers-pane](../workers-pane/brief.md), whose richer rows and "N in Workers" fold were built in
#252; this one is about the pane as a whole: list, open worker, its tools and the way back.

## Problem

Johan wants one pattern: the orchestrator always in the main pane, its workers in the right pane,
listed by state, a click opening one in the same pane with a "Workers › title" way back, as a
reference app does it. Today:

1. The pane's rows say less than the sidebar's rows for the same workers, in another shape (no
   agent mark, a different age, a different dot, running workers with words the sidebar leaves
   out). The sidebar's row is the one to take.
2. An open worker sits under three bars (the panel's tabs, "Thread › title", its own
   Conversation/Terminal/Changes) and its "Thread" crumb isn't a link. Back to the list is the
   Workers tab, one tab over; Esc does nothing.
3. The panel's Diff, PR, Files and Terminal are the orchestrator's while a worker is open, so the
   worker's tools are a second strip, and the PR tab says "An orchestrator has no pull request of
   its own" beside a worker with one.
4. An embedder that hides Gram's thread lists offers the panel only on a thread in a repository,
   so beside an orchestrator there is no pane and no worker list at all.

The right pane is wider than the sidebar, and its whole height is for one job: the orchestrator is
already picked, so it is only for seeing each worker's state and picking one.

## Who and where

Someone running an orchestrator with several workers, from the orchestrator's chat, desktop
(1440×900) and narrow (1024×768, sidebar as its rail); also inside an embedder's shell.

## Must show

- The sidebar's worker row in the pane, wide: its dot or bar, title, agent mark, age, the status
  line in full (amber only for needs you), PR chips, plan progress, and the docs or mocks a worker
  made as thumbnails. Groups Needs you, Running, Waiting, Done (folded to its latest).
- The open worker in the pane: where you are (Workers › title), back by a click and by Esc, and its
  own Conversation, Changes, PR, Terminal and Files.
- Per direction: A the pane as a Workers mode (list ⇄ worker); B a worker as a tab beside a first
  Workers tab; C the list and the worker side by side when the pane is wide, with the sidebar
  handing an orchestrator's workers to the pane while it shows them.
- Light and dark, desktop and narrow.

## Out of scope

The sidebar's own row internals, the Board, new states or colours, the phone layout, product code.

## Open questions (defaults picked)

- Age on a row: last activity, in both lists (today the sidebar shows started, the pane last
  activity). Default: last activity.
- "N need you elsewhere" leaves the pane (the sidebar's needs-you pill and the Inbox say it).
- The orchestrator's own Diff, Files and Terminal (main's) move behind More while the pane is on
  Workers; the orchestrator has no PR of its own.
