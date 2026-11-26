# Board grouping: handoff

- **Target**: `v1.html`, board "A Flat lines". Johan approved it (Q156, 26 Nov). The page's
  stale-stage tweak stays at its default, "grey with its date".
- **Decisions**: the v1 line in `decisions.md`. B Earned bands and C By state are dropped.
- **What changes**
  - No group bands. Every live feature is one line in the grid, whether or not it is in a group,
    so the Other heading goes too.
  - One Stage cell per line. It shows the feature's own `set_stage` plan, else its group's. A
    planned stage draws its pips with "name · n of m"; a free label draws the name alone. With
    no stage, the cell keeps the station bar. A feature with several workers keeps each worker's
    station bar on its worker rows.
  - A stage set before the line's latest report is drawn grey with "set <date> <time>" under
    it (24-hour). A current one keeps the accent.
  - The group is a quiet tag (layers glyph and name) on the line's second line, where the stage
    chip was. The chip goes, since the Stage cell now says it.
  - The header gets a filter: All, one chip per group with live lines (with its count), and
    No group. It shows only when a live line is in a group.
  - A group with no live line isn't drawn anywhere on the Board.
  - The Done band is unchanged.
- **Keeps**: the `set_group`/`set_stage` data and tools, the MCP contract, the feature sheet's
  stage editor, and the phone Board's layout (it has no bands).
- **Parts**: the plan's pips → `StageLine`/`StageStepper` (`orchestration/stage-stepper.tsx`).
  The station bar → `StationSteps` (`views/board-grid.tsx`). The tag → a muted text span with
  `Layers`. The filter chips → buttons with `aria-pressed`, like `PeopleStrip`. `title=` hints →
  `Hint`.
- **Deviations allowed**: real lengths of names and notes; where the filter sits in the header.
  Not allowed: bands, two stage claims on one line, empty groups drawn.
- **Gaps**: the mock's `[what it waits on]` and `[its latest report]` placeholders come from
  the real worker; nothing to fill by hand.
