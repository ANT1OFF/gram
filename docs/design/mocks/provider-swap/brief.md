# Continue in another agent

Written by the design-brief skill before the first version. Keep it short; it is what the mock is
checked against. Source: the Gram doc "Plan: swap a thread's provider", rev 4, §3.1 to §3.6, and
decisions D1 to D5 (2026-11-11).

## Problem

A thread started in Claude Code can't carry on in Codex, or the reverse. When Claude runs out of
usage mid-task, or the other agent suits the work better, the user has to start a new thread and
retell it. Only the orchestrator can switch today ("Switch orchestrator…"), and its new session
remembers nothing of the conversation.

## Who and where

- Anyone with both CLIs installed and signed in, on a solo thread or a worker.
- **Entry:** the composer's choices chip, Model section, where the other agent's models are a
  group of their own; and the thread's "…" menu, "Continue in Codex…" (or "Continue in Claude
  Code…"). Both open the same short confirm sheet. A pick changes nothing until Continue.
- **After:** the transcript's handoff divider, and the composer's chip on the new agent's mark.

## Must show

- **Popover group:** below the current agent's models, the other agent's mark (its words on
  hover: "Continue in Codex: new session with a handoff") and its models, each ending in "…".
  - Offered, and greyed with its reason on hover: a turn running ("Wait for this turn to finish,
    or stop it, then switch."), signed out ("Sign in to Codex in Settings → Agents.").
  - Not installed: no group at all (not drawn; nothing new shows).
- **Menu item:** "Continue in Codex…" first in "…", offered and greyed with an approval waiting
  ("Answer the open approval first. It can't move to Codex.").
- **Confirm sheet**, title "Continue in Codex":
  - Model and effort; effort lists the target's efforts up to High.
  - What Codex gets, and what it doesn't (Claude's tool output, reasoning and cache: the first
    reply is slower), one line each.
  - Normal mode: "Ask Claude for a handoff note first", ticked.
  - Limit mode: in its place, "Claude is out of usage until 15:00, so Codex's first turn writes
    the note from the transcript and does no other work." The recent turns grow to about 24k
    tokens.
  - A worker: its PR, merge when ready and checks stay with it; its orchestrator hears in its
    next digest. The permission mode only when it changes ("Codex runs this in Bypass. Its Auto
    needs Codex 0.166 or newer.").
- **Divider:** "Continued in Codex · GPT-6.1-Sol · 14:02", the previous session on hover, and a
  chevron that opens "What Codex was given" (the note, who wrote it, Gram's facts, the turns).
  Limit mode: Codex's first turn is the note and nothing else; a queued message waits for it.

## Out of scope

- The switch's progress text (`switchStatusText`, generalised in the build, no new look).
- The orchestrator: its menu item becomes "Continue in Codex…" and uses the same sheet (cut 6).
- Joined machines, Windows, gateway profiles and forks: refused or not offered, same greyed look.
- Settings → Workspaces' orchestrator switch row.

## Open questions

- The popover group's heading is the mark alone, its words on hover (the user's preference;
  default). The models end in "…" because a pick asks before acting (DESIGN.md's voice rule).
- What Codex gets and doesn't are two lines led by a check and a cross glyph, the glyphs' words
  on hover (default), rather than a heading per line.
- The worker's binding note and its digest line share one line (default).
- Example names: the thread "Sort History by last activity", the models Opus 5.5 and
  GPT-6.1-Sol; the session id and PR number stay gaps.
