# The Board for more than one person

Written by the design-brief skill before the first version. Keep it short; it is what the mock is
checked against.

## Problem

The Board was drawn for one person's orchestrator: a row per feature, Task · Stage · Now · Pull
request. Once two people's agents (and an agent that runs for a group) share a Board, the
questions change: whose is this, what is everyone on right now, what is mine, and is anyone about
to clash with me. Adding an owner to today's row (board-owners v1) answers the first only.

## Who and where

Two or three people in one workspace family, each with their own orchestrator, and a shared agent;
from the Board, several times a day, and before starting something new.

## Must show

- Real-looking features: four or five, across three owners (You, Grace, a shared agent named
  "Release agent"), at different stations, one needing you, two overlapping on files.
- Whose each feature is, what it is doing now, and its PR.
- An overlap between two people's work, and where you'd act on it.
- The same facts in every direction, so they compare by structure.

## Directions

- **A Rows**: today's grid; the owner on line two; a filter (Everyone · Mine · each person) in
  the header; the overlap on the row it touches.
- **B Lanes**: one band per person, their features under it; a band folds; overlap links the two
  rows across bands.
- **C Stations**: columns per station (Briefed to Merged), a card per feature with its owner;
  overlap as a mark on both cards.
- **D People**: a strip of people across the top, each with what they're on now and what waits on
  them; clashes first; the grid below filtered by whoever is picked.

## Out of scope

Tasks and claims (phase 4), the phone layout, colour per person (DESIGN.md keeps colour for status
and agents), editing a stage.

## Open questions

Which direction, or which parts of which. Whether a shared agent's work reads as a person (its own
band, filter, strip entry) — assumed yes.
