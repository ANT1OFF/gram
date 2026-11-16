# Fresh session from the context chip

**Problem.** A user who wants the orchestrator to start over from its memory has to find Fresh
session in the `/` menu, the palette or the thread menu; the context chip that offers it shows
only past 90%. And Fresh session always asks the orchestrator to save to memory first, so an
orchestrator that is stuck in a long turn, looping or confused can't be cut loose: the handoff
waits behind its turn or its open card.

**Who and where.** Anyone with a workspace, in the orchestrator's thread header (desktop and
phone). The `/` verb, the palette and the thread menu open the same choice as a dialog.

**Must show.**

- The context chip always present and quiet (for example 64%), in the warning colour from 90%.
- A popover anchored to the chip: the context fill, one line on what carries over, the
  **Save to memory first** checkbox (ticked by default), and **Start fresh session**.
- Unticked: the line says the current turn stops now and anything not in memory is left behind;
  if the orchestrator has an approval card open, the popover says it is declined, as Stop would.
- Handing off: the chip becomes the existing "Handing off…" spinner.
- After: the transcript's existing divider, "New session · you asked for one", and its hard-cut
  form.
- The dialog the menu, palette and `/` verb open, with the same checkbox.
- Phone: the same popover from the header chip.

**Out of scope.** Continue in… (the handoff-note sheet) stays as it is. No change to the
automatic handoffs, memory screen or Board.

**Open questions (defaults picked).**

- Checkbox, not two buttons: matches Continue in…'s "Ask … for a handoff note first" box.
- The chip shows at every fill, quiet below 90%, rather than only past a threshold.
- A hard cut declines an approval card the orchestrator has open (as Stop does); its questions (`questions.md`) and workers' cards stay.
