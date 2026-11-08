# Composer icons: handoff

[Brief](brief.md) · [Decisions](decisions.md) · [Approved page](v1.html)

## Target

`v1.html`, direction **A Solid stop**:

- **Stop** (`composer.tsx`, `styles.ts`): `ROUND` (32 px) with the text-colour fill, danger
  under the pointer; the filled square inside `RingSpinner`; no word, no key cap. Tooltip
  "Stop (⌘.)", accessible name "Stop". Waiting on an answer: `bg-destructive-tint`,
  `text-destructive`, no ring. The shortcut stays.
- **Choices chip** (`choices.tsx`): the agent's mark, then a 14 px glyph per section that sets
  one (`glyph` on `ChoiceSection`): the mode's lock-open in the warning colour for Bypass, the
  filled bolt for Fast. No words; the tooltip and accessible name list every value. Where no
  mark is given (the `/new` prompt box, whose agent picker carries it) the chip draws the
  sliders glyph. The words-to-glyph fallback chain (`toolbarLayout`'s sizes) goes.
- **Context meter** (`context-ring.tsx`): the 20 px bar alone in a 32 px target; "Context 36%"
  in its hover popover, which already opens on hover, and in its accessible name.

## Gaps

The `/new` prompt box's agent picker loses its word too, for one rule across composers; the
gateway profile picker, shown only with a gateway key, keeps its word.
