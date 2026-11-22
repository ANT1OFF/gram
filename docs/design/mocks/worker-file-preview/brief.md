# Previewing a worker's file

## Problem

"When I am in the worker in the right tab view, clicking preview does not work." The worker pane
on the right has no Preview tab of its own, so the file card's Preview does nothing there. In the
middle, Preview opens the Preview tab, but for a worker on another machine it said "Not found":
the worker had committed the doc to another branch and checked out a new one, so the file was no
longer in its worktree, and the tab said nothing more useful.

## Who and where

Someone running an orchestrator with workers, often on a joined or hosted machine, reading a
design doc or page a worker just wrote: from the worker open in the right pane (Workers > worker >
Conversation) or from the worker open in the middle.

## Must show

- Right pane: where the file opens when the pane is too narrow for a Preview tab.
- Middle: the Preview tab, as today, and a way to pop either one out.
- Following live while the worker keeps editing (it re-reads after each write).
- The machine the file is on ("atlas"), loading from it, and "atlas is offline".
- The file gone from the worktree: what the worker last wrote, taken from its conversation.
- Markdown rendered with a Source switch; images; code; HTML (local renders, remote shows source).

## Out of scope

- Editing the file. Rendering a remote machine's HTML page live (it stays source for now).
- The Files panel's own viewer, which this reuses.

## Open questions

- Right pane opens a centred window over the app (default) or a sheet over the pane itself.
- Esc and clicking outside close it (default yes).
