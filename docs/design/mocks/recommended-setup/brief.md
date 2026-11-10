# Recommended setup

Written by the design-brief skill before the first version. Keep it short; it is what the mock is
checked against.

## Problem

Gram ships a recommended model per kind of work (Lead, Scoped, Cheap, Top), resolved on each
machine. Users can't yet turn that on, can't tell which model slots follow it and which are their
own, and have no one-click way back to following once they've pinned something.

## Who and where

- **Settings → Agents & models:** the Recommended setup switch at the top of New threads, with a
  Details fold of what each tier is on this machine.
- **Settings → Workspaces:** the orchestrator model and worker models carry a glyph each.
- **Turning it on** in an existing install opens a one-time sheet; turning it off asks once.
- **Welcome (new installs):** one row with the switch already on.

## Must show

- **Glyphs on a model slot:**
  - Follows: Lucide `sparkles`, hover "Recommended · Lead tier · updates with Gram".
  - Yours: Lucide `pin`, hover "Your choice · updates leave it alone", with a `rotate-ccw` "Follow recommended" icon button beside it.
  - Words go on hover, never on the row.
- **Switch row:** off, then on, with this machine's one-line summary. Example machine with both installed: "Opus 5.5 leads, GPT-6.1-Sol does scoped work, Haiku 5.5 helps".
- **Details fold:** tier → model · effort, and each tier's note, from `table.json` 2026.11.
  - Lead: Opus 5.5 · medium. Scoped: GPT-6.1-Sol · medium. Cheap: Haiku 5.5 · medium (helpers: titles medium, the rest low). Top: Fable 5.1 · medium (5.2 once Claude Code lists it).
- **Turn-on sheet:** one row per slot, `before → Recommended (model, effort)`, with a checkbox.
  - Past Gram defaults are pre-ticked: orchestrator `claude:opus · high`, an unset default model, unset helpers.
  - Any other value is pre-unticked as "Keep yours".
- **Turn-off question:** "Keep the current models as your own" (recommended: pins each following slot to what it runs on now), or "Keep following".
- **A following effort menu ends at High.** A pinned one offers what the CLI lists.

## Out of scope

- What's New lines (cut 9).
- The failed-turn retry menu (cut 7).
- Joined machines (cut 8).
- Claude subagents (not chosen).

## Open questions

- Glyph placement: before the model name, as DESIGN.md's agent mark is (default).
- Sheet button wording: "Follow recommended" for the primary, "Cancel" (default).
- Details fold: collapsed by default, opened by its chevron (default).
