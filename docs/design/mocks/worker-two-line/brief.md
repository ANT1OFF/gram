# Two-line worker rows

## Problem

A worker row in the sidebar is one line: a state dot, the title, and one word or a PR chip at its
edge. Its agent's mark now always shows, which takes room from the title, and what the worker has
done (its PRs, their checks, how many merged) only shows when nothing else wins the edge.

## Who and where

The person watching several orchestrators in the desktop sidebar (about 300 px wide), light and
dark. The compact strip's flyouts use the same row.

## Must show

- Line 1: state dot, title, agent mark on the right.
- Line 2: PRs (each number while there are one or two; "N merged" once there are more), checks
  failing or running, an ask, a wait's reason, and an age (started, or last active).
- No line for the command a worker runs; that stays on the hover card.

## Out of scope

Orchestrator rows, solo threads, the Board.

## Open questions

- Whether a row with nothing to say keeps two lines (A) or drops to one (B, C).
- Whether the age is time since start or since last activity (tweak).
