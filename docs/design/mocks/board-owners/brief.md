# Whose work each Board row is

Written by the design-brief skill before the first version. Keep it short; it is what the mock is
checked against.

## Problem

When more than one person's work lands on one workspace's Board (an embedder that signs people in
and starts threads for each of them), every row looks the same: nobody can tell whose feature is
whose, so two people step on the same work or message the wrong orchestrator. Gram already knows
who started each thread (`createdBy`, the signed-in subject) but the Board never says it.

## Who and where

Anyone reading the Board (`views/board-grid.tsx`, the grid; `views/board-phone.tsx`, the cards)
of a workspace where at least two people have started work.

## Must show

- The row's second line (where the machine marker, stage chip, repos and summary already sit)
  names the person a feature's workers act for, as a person glyph and their name, muted. A worker
  spawned by an orchestrator acts for the orchestrator's person.
- A feature with workers for two people names both ("Grace, Magnus").
- A worker sub-row names its person only when it differs from its feature's.
- The rule the repos already follow: a Board where every row is one person's says nothing, so a
  single-person Gram looks exactly as it does today (state "One person").
- A person Gram has no name for shows as "Someone else"; the signed-in viewer's own rows say "You".

## Out of scope

Filtering by person (Mine and Everyone is a later phase), avatars or colours per person (DESIGN.md
keeps colour for status and agents), the stage editor, the phone cards' layout beyond adding the
same words.

## Open questions

- Owner on the second line, beside the repos (default), rather than a column of its own: a column
  costs width on every Board for a fact most Boards don't have.
- "You" for the viewer's own rows (default) rather than their name.
