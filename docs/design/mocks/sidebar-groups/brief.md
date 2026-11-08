# Sidebar groups

Written by the design-brief skill before the first version. Keep it short; it is what the mock is
checked against.

## Problem

R15's raters (4 of 4) read the overview sidebar as many uneven groups: Orchestrators, "Idle · 2",
"Solo threads 9", "Pull requests 6", "11 done" and History, each with its own header weight, count
placement and row rhythm, and worker rows of two heights ("Waiting · checks" and "asks you" on a
second line). The reference groups by state ("Waiting on you", "Idle", "Resolved").

## Who and where

Anyone with the Orchestrator layout's sidebar open: tour 02, 08, 12 and stress 25, at 1728 px.

## Must show

- Fewer groups, one header style (muted 13 px, count in one right column), one row height.
- The same data as tour 02: Gram open with four workers (one waiting on checks), billing-api
  asking, two idle workspaces, nine solo threads, six PRs, eleven done.

## Out of scope

The compact rail's look (only its name on hover changes), the pill, Search and the foot.

## Open questions

Which subtracts more: one header style over the same six groups (A), or the resting groups merged
into one At rest fold (B)?
