# The Board for more than one person: handoff

- **Target**: `v2.html`, board "Board", states everyone, picked and one. Approved by Johan (16:37,
  "go with your recommendation").
- **Decisions**: v1 → v2 in `decisions.md`.
- **Parts**: the clash line is a bordered strip (`views/board-people.tsx`, `ClashLine`); the people
  cards are buttons with `aria-pressed` (`PeopleStrip`); the owner on a line is `OwnerMark` on the
  row's second line (`views/board-grid.tsx`); `.btn` → `components/ui/button`.
- **Deviations**: the clash line's actions are the workers' names (each opens its worker) and
  "Message the orchestrator", as one workspace has one orchestrator; "Tell Grace's orchestrator"
  waits for a family of workspaces. Group by person (the "grouped" and "menu" states) is not built
  in this change.
- **Gaps**: none.
