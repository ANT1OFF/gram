# Recommended setup: handoff

[Mock](v1.html) · [Brief](brief.md) · [Decisions](decisions.md)

## Target

The build must match `v1.html`, approved 2026-11-10. Boards and states:

- **1 Off:** Settings → Agents & models with the Recommended setup row first in New threads, its switch off. No glyphs anywhere while the mode is off.
- **2 Turn on:** a one-time sheet when an existing install turns the mode on.
  - One row per model slot, each with a checkbox and `before → Recommended <Tier> · <model> · <effort>`.
  - Past Gram defaults come pre-ticked: the orchestrator at `claude:opus · high`, an unset default model, an empty roster, unset helpers. Values the user picked come unticked as "yours, kept".
  - Buttons are Cancel and Follow recommended. The sheet never shows again once confirmed.
- **3 On** (states `folded`, `details`):
  - The switch is on, with this machine's one-line summary.
  - A Details fold (chevron, starts folded) opens a tier table: Tier · On this Mac · For, from the table's notes, then "Recommendations <version>. Effort never goes past High."
  - The default model shows its Follows glyph, and its effort menu ends at High.
- **4 Roster:** each workspace model slot has its glyph before the chip.
  - Follows: sparkles in the accent text colour.
  - Yours: pin in muted, with a rotate-ccw Follow recommended icon button.
  - Words are on hover only. An unavailable tier keeps the warning line under its row.
- **5 Turn off:** asks once, with Cancel, Keep following, and Keep current models (primary). Keep current models pins each following slot to what it runs on now.
- **6 Welcome:** on a new install, the row with the switch on and the summary.

## Decisions

- v1 approved as drawn. The glyph sits before the model chip; the sheet's primary button reads "Follow recommended"; Details starts folded.

## Parts

| Mock                             | Becomes                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `.group` / `.set` rows           | `SettingsGroup` / `SettingRow` (`apps/web/src/settings/fields.tsx`)                             |
| `.switch`                        | `components/ui/switch` (via `Toggle` in `fields.tsx`)                                           |
| Details fold                     | `components/ui/collapsible`                                                                     |
| Tier table                       | a plain `<table>` in the row's detail slot: new, small                                          |
| `.glyph` sparkles / pin          | Lucide `Sparkles` / `Pin` at `size-icon-row`, wrapped in `components/ui/tooltip`: new component |
| rotate-ccw icon button           | `components/ui/button` `size="icon-xs" variant="ghost"`, Lucide `RotateCcw`, with a tooltip     |
| `.slot` chip                     | the existing model fields (`AgentFields`) and roster rows; only the glyph is added              |
| Effort menu ending at High       | `effortOptions` filtered to `none…high` for a following slot                                    |
| `.dialog` sheets (turn on / off) | the app's dialog pattern (as in `confirm-strip.tsx` / existing dialogs): new sheet component    |
| `.badge` Default                 | the roster's existing Default star button                                                       |
| warning line                     | the roster's existing `IssueNote`                                                               |

## Deviations allowed

- Real data lengths, model display names as the CLI lists them, and the platform's own controls.
- Not allowed: changing the structure, hierarchy or states above.
- Not allowed: putting words on a row where the mock has them on hover.

## Gaps

- **6 Welcome:** `[Welcome copy as today]` and `[Today's primary action]` stay whatever the welcome screen already says. Only the row is new.
