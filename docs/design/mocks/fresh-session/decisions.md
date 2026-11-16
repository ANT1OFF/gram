# Fresh session from the context chip: decisions

One line per review round: what was asked, what changed, in which version. The mock-review skill
keeps this; the build reads it with the approved version.

- v1 (2026-11-16): Johan approved the popover with **Save to memory first** ticked by default
  and one change: leave context use out of it. Compaction already handles a full context; a fresh
  session is for dropping what is in the conversation, compacted or not. So the build has a plain
  Fresh session icon (refresh) always in the header, and the popover shows no context fill or
  meter. The hard-cut line also says an approval card it waits on is declined (as Stop does), and
  its questions carry over.
