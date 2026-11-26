# Board grouping

Written by the design-brief skill before the first version. It is what the mock is checked against.

## Problem

Johan, 26 Nov: "i want to rework the board the stage grouping i am not sure about the grouping."

The Board puts live feature lines under named group bands (`set_group`). Each band has its own
state pill, a feature count, a stage with a plan (`set_stage group=`) and Edit plan. Each line
under it also has a station bar (Briefed → Merged) and a Now line. In this workspace that goes
wrong in four ways:

- **Groups outlive their work.** The ledger holds 54 groups. A band whose lines have all gone to
  Done stays while its plan has steps left (`railEntries`), so mcp-parity, durable-state,
  deps-bump-nov and release-2026-11-16 show "0 features" with stages set 10–12 days ago.
- **Two progress claims per line.** arch-fixes says Merged and "Live in prod 4/4", while its one
  live line (Save work on spot loss) waits on train 7. The group's stage is the orchestrator's
  word from 19 Nov. The line's bar is derived from the PR now. They disagree, and the Board
  doesn't say which one is current.
- **The band repeats its line.** Every band on screen holds one live line, so the header (name,
  Merged, "1 feature") says again what the row under it says.
- **Done is a second board.** "Done 1090" follows the groups as a table of its own.

## Who and where

Johan, from an orchestrator's Board, several times a day: "what's moving, what waits on me,
where does each release stand". The orchestrator writes the groups and stages; Johan reads them
and sometimes moves a stage.

## Must show

- The real live lines: Release Gram 1.44.0 + RunHeim pin (gram-1-44, Review, PRs #1051 merged
  and RunHeim#2911 open); Save work on spot loss (arch-fixes, waiting on train 7, #830); Idle
  release: phase 1 measurement (hosted-machines, waiting until 30 Nov 06:27, on cachyos, #995
  and #2476); Fix: worker move requests ignored (gram-1-43, #1031); Board grouping rework (no
  group, working); Remove helper-suggested follow-up tasks (no group, blocked).
- The real plans: gram-1-44 "Published" 3 of 4; arch-fixes "Live in prod" 4 of 4 (set 19 Nov);
  gram-1-43 "RunHeim pin live in prod" 5 of 5; hosted-machines "Idle measure" (no plan).
- The four groups with no live line and stale stages.
- The Done band, drawn the same way in every direction, so the directions differ only in how
  live work is grouped.

## Directions

- **A Flat lines**: no bands. One line per feature, one Stage cell: the plan when the feature or
  its group has one, else the station bar. The group is a quiet tag on the line and a filter in
  the header. A group with no live line isn't drawn.
- **B Earned bands**: bands stay, but only for a group with two or more live lines. A one-line
  group draws as its line with the tag. A group with no live line folds into one "Resting"
  line. A stage older than its lines' last report says when it was set, in grey.
- **C By state**: sections Needs you, Moving and Waiting, derived from the line's state. None
  of them is kept by hand. The group is a tag, as in A. (By repo was tried and dropped: all six
  live lines are in gram today, so it drew one section.)

## Out of scope

Thread plans written by the helper model, which are being removed (remove-helper-suggested-tasks,
worker 6cd9dfdc). Every plan drawn here is a `set_stage` plan the orchestrator set. Plans that
agents set themselves may come later, pending that worker. Also out: the people strip and clash line
(board-owners), the phone Board, the stage editor's form, and the Done band's own design.

## Open questions

- Whether groups stay in the product at all, or survive only as tags and filters (A and C). The
  default is to keep the `set_group` data either way, so this is only about the view.
- What "stale" means: assumed to be a stage set before its lines' latest report.
