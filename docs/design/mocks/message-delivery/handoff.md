# Message delivery while a turn runs: handoff

[Brief](brief.md) · [Decisions](decisions.md) · [Approved page](v1.html)

## Target

`v1.html`, direction **B Split button**, with the **Sent messages** board:

- **Composer** (`composer.tsx`): while a turn that takes input runs and the composer holds a
  draft, a chevron sits before the round button and opens a menu: Steer (↵, "After the current
  tool call"), Queue (⌥↵, "After the turn ends"), Interrupt (⌘., "Stops now, cuts off tool
  calls"). The round button steers; its glyph follows a held ⌥ (queue) or ⌘ (interrupt). On a
  phone the chevron is its own 44 px target.
- **Keys:** ↵ (or ⌘↵ under "⌘↵ sends") steers, ⌥↵ queues, ⌘. with a draft interrupts; ⌘. with
  an empty composer still stops.
- **Codex** can't be interrupted for a message: Interrupt there steers, and says so.
- **Sent messages** (`message-actions.tsx`): "Steered" or "Interrupted the turn" with its glyph
  beside the time under the bubble; a queued message stays in the queue card as today.
