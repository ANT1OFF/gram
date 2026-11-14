# Conversation only: decisions

One line per review round: what was asked, what changed, in which version. The mock-review skill
keeps this; the build reads it with the approved version.

- v1, 2026-11-14: three directions shown (A Clean, B Receipts, C Beside). **A Clean** picked:
  the work is gone from the transcript and a running turn shows one Working line.
- Build: a failed tool call is hidden with the rest, since the agent usually recovers and an
  error that stops the turn has its own card. An approval needs no row: its card sits above the
  composer. The switch is also a checked item in the title bar's View and a pane's "…".
