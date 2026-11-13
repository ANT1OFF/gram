# Phone thread: reaching Diff, PR, Files and Terminal

## Problem

On a phone a thread's right panel (Diff, PR, Files, Terminal) opens only from a tap on the pull
request bar above the prompt box. Nothing says the bar does that, a thread with no pull request
has no way in at all, and the "…" menu's View lists Contents, Focus and History but no panel. Once
open, the panel covers the whole screen under an empty strip where the title bar was, and the way
back is an unlabelled collapse glyph at the end of its tabs.

## Who and where

- Someone following a coding thread from a phone: they answer an approval, then want to see what
  changed or why a check fails before they allow a push.

## Must show

- A thread in a repository on a phone (390 px), with its plan strip, pull request bar and prompt
  box, and where each panel is reached from.
- The panel open on a phone: which thread it belongs to, and the way back.
- A thread with changes but no pull request yet still reaches Diff and Files.

## Out of scope

- What each panel shows inside (the diff's own layout, the PR tab's sections).
- The desktop and tablet bar.

## Open questions

- Assumed: a thread outside a git repository offers no panel, as on desktop under `panel: "code"`.
- Assumed: Terminal stays reachable on a phone, last among the four.
