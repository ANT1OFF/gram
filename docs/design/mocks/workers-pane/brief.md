# Workers pane

Written by the design-brief skill before the first version. Keep it short; it is what the mock is
checked against.

## Problem

Johan wants one pane at the side that lists every worker by where it stands and opens one on a
click. Gram already has it: the right panel's Workers tab (`orchestration/workers-panel.tsx`),
grouped Needs you, Running, Waiting, Stopped, Done, a click opening the worker beside its
orchestrator's chat. Its rows say only a title and an age, so the list says less than the
sidebar's rows above the same workers, and the workers are listed twice. R13's raters found Gram
busy, so the answer is to make this tab the one worker list, not to add another surface.

## Who and where

Someone running an orchestrator with several workers, from the orchestrator's chat or a worker
open beside it, with the right panel open on Workers.

## Must show

- A row: state dot, title on one line (wave 16's rule: cut at its end, whole on hover), age, then
  one muted status line (the sidebar's `ROW_STATUS` words, amber only for needs you), with PR
  chips and plan progress trailing only while they fit beside the words.
- Group headings with a quiet count; empty groups fold to their heading.
- The open worker as the current row (`choice-selected`).
- Directions: A richer rows only; B also folds the sidebar's workers to one line while the tab is
  open; C lets the tab list every workspace.

## Out of scope

Sidebar row internals (wave 16, `claude/hc16-sidebar`), the status band (`claude/hc16-one-band`),
new states or colours, the Board.

## Open questions

Which direction. Whether Waiting splits off an "In review" group (a PR open and waiting on a
review), as the reference has "Ready for review".
