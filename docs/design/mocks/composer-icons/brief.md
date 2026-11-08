# Composer icons

[Decisions](decisions.md) · [Handoff](handoff.md) · [v1](v1.html)

## Problem

Johan, 2026-11-08: "we have moved too far in the text direction. I would rather want icons with
text on hover. Especially the stop button is horrible." The composer's row had grown words: Stop as
a solid pill reading "Stop ⌘.", the choices chip saying "Claude Opus · High · Auto", the context
meter saying "Context 36%".

## Who and where

Everyone who writes in a composer: the orchestrator's chat, a solo thread, a worker, and `/new`'s
prompt box.

## Must show

- Stop as a 32 px icon button in Send's place: the square in the running ring, no word, no key
  cap; its quieter state while the turn waits on an answer.
- The choices chip as icons: the agent's mark, plus a glyph only for a value off its default that
  matters for safety or cost (Bypass, Fast). Its tooltip lists every value and shortcut.
- The context meter as its bar alone.

## Out of scope

The popover's contents (they keep their words) and the worker's "Sending takes over from the
orchestrator" line (a warning, not a control).

## Open questions

Stop's fill: solid in the text colour (A) or an outline (B).
