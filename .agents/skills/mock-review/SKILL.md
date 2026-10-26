---
name: mock-review
description: Take feedback on a mock through to an approved version and hand it to the build. Use when the user comments on, picks between, asks to change, or approves a mock in docs/design/mocks.
---

# Mock review

The last step of the mock-first loop: turn feedback into the next version without losing what was
already agreed, record each decision, and when the user approves, hand the build a clear target.
Mocks are built with [mock-build](../mock-build/SKILL.md).

## A review round

1. **Read the record**: the mock's `mock.json` (which version is current), `brief.md` and
   `decisions.md`, then the current version's page.
2. **Map the feedback to boards.** Use the names on the page ("A Inline", "Empty state").
   When the user picks a direction, the next version develops only that one, at higher fidelity;
   the others are dropped, not blended in unless asked.
3. **Change only what was asked.** A targeted comment gets a targeted change. Don't restyle,
   reflow or rename anything else; if something else looks wrong, say so in the reply instead.
4. **New version, never an edit**: `node .agents/skills/mock-build/scripts/new-mock.mjs <slug> --next`,
   Read the current page, Write the next `vN.html` whole with the Write tool (so it shows in the
   Files view beside the earlier ones), retake the changed boards' screenshots in the local
   `shots/`, and
   show it with `show_mock` (and `show_panel` preview at `vN.html#<board id>` for the board that
   changed). Never hand over a bare path.
5. **Record it**: append one line to `decisions.md`, for example
   `v3: picked B Panel; header quieter; empty state gets the import action (asked 14:20).`
6. **Reply** with what changed, by board name, and anything you chose not to change and why.
   A pick between directions is a question with pictures: each option's `image` and `preview`,
   and the mock in `mock` (mock-build, step 6).

Ask only when the feedback contradicts the brief or an earlier decision; otherwise do the
reasonable reading and say which reading you took.

## Approval

When the user approves ("ship it", "this one", "approved"):

1. Check the approved page once at 1280 px and 390 px, light and dark, and fix only a defect
   (overflow, unreadable text, a state that shows nothing) as one more version, saying so.
2. `node .agents/skills/mock-build/scripts/new-mock.mjs <slug> --approve <n>`.
3. Write `handoff.md` in the mock folder with the Write tool:
   - **Target**: the approved file, and the boards and states the build must match.
   - **Decisions**: the lines from `decisions.md` that still hold.
   - **Parts**: each kit part the mock uses, mapped to the real component or the place in the code
     it becomes. In Gram the components are in `apps/web/src/components/ui/`:
     `.btn` → `button`, `.segmented` → `button-group`, `.badge` → `badge`,
     `.callout` → `alert`, `.switch` → `switch`, `.tabs` → `tabs`, `.select` → `select`,
     `.menu` → `context-menu`, `title=` hints → `tooltip`, disclosure rows → `collapsible`;
     anything with no match (cards, dividers, scrolling boxes) is flagged as new.
   - **Deviations allowed**: what the build may change without asking (real data lengths,
     platform controls) and what it may not (structure, hierarchy, the states).
   - **Gaps**: every bracketed placeholder still in the page, which the build must fill from real
     data or raise.
4. Tell the user it's approved, with the approved version's `show_mock` card, and where the
   handoff is. The build works from `handoff.md` and
   the approved page; a later deviation is recorded in `decisions.md`, not silently made.

## Comparing the build

When the build is up and the user asks to compare, open the approved page and the running app
side by side, and list differences by board: matched, deviated with a reason, or missing. Fix
what is missing in the build, not in the mock.
