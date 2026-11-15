# Composer while an agent works: handoff

[Brief](brief.md) · [Decisions](decisions.md) · [Approved page](v1.html)

## Target

`v1.html`, direction **A Delivery chip**. It replaces the chevron from
[message-delivery](../message-delivery/handoff.md).

- **Chip** (`composer.tsx`, `DeliveryChip`): while a turn takes input, before or after typing, a
  chip before the round button shows the picked way's glyph and word ("Steer") and a chevron. It
  opens Steer, Queue and Interrupt as radio items, each with a line and its key, then "Stop without
  a message". A pick sets the way for one message, returns focus to the field, and goes back to
  Steer after a delivery or when the turn ends. Below a 20rem composer only the glyph shows.
- **Round button and ↵** send the picked way. A held ⌥ or ⌘ still wins, and ⌥↵ and ⌘. are unchanged.
- **Placeholder** says the picked way: "Steer the agent…", "Queue a message for after this
  turn…", "Interrupt with a message…" (for a worker: "Steer this worker…" and so on).
- An agent that can't steer gets no chip and the placeholder still says "Queue a message…".
