# New entry points: decisions

One line per review round: what was asked, what changed, in which version. The mock-review skill
keeps this; the build reads it with the approved version.

- v1 approved (2026-10-26): the user picked A Menu over B Composer, C Split and D Rows, with no
  further comments.
- Build: ⌥⌘N is free in `keyboard/catalog.ts` (⌥⌘ takes only arrows, B, R, S, P, J, W, 1–4 and
  Enter), so the worker keeps the proposed ⌥⌘N. The remembered choice is the row the menu opens
  on, as the board's note says ("the last one used is focused"); a plain click on `+` still opens
  the menu, and ⌘N, ⌥⌘N and ⌘T keep going straight to their screens. The menu is 320 px, not 300,
  so "Task for <workspace>'s orchestrator" fits a typical name; longer names truncate with the
  full label on hover.
- Build: New task loses its "Who picks it up" radio, as the board's task screen shows; the menu
  (or ⌘N / ⌥⌘N) picks the way, the page says it in its heading and target chip, and the way a
  workspace's last task went is no longer remembered per workspace. The `+` keeps an icon-only
  button, its hover text "New task, worker, one-off thread or workspace" in place of "New… (⌘N)",
  since ⌘N skips the menu.
