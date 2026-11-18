# Start fresh on another model

Written by the design-brief skill before the first version. Source: Johan's feedback from coding
in Gram embedded in another app (18 November 2026), item 4, and gram #753 and #756.

## Problem

"I changed the model. Will the next task use it?" The workspace settings save an orchestrator
model, but the running session stays where it was. Continue in… moves a session only between
Claude Code and Codex, on the CLI's own sign-in, on this machine, off Windows. Everywhere else
(a gateway account, a machine that isn't this one, OpenCode, Windows) the move is refused, and
since #756 the task preview says so and Start is greyed. The person is left with no way to get
onto the model they chose short of closing the orchestrator and opening a new one.

## Who and where

- Anyone whose orchestrator (or a thread) runs on another model than the one they want.
- **Entries:** Settings → the workspace's Models row ("Saved: X. The running session stays on
  Y"), the New task form's orchestrator line when the task picks another model, and the thread's
  Continue in… where the move can't happen.
- **After:** the transcript's divider, and the composer chip on the new model.

## Must show

- The one action: **Start fresh on Claude Code · Opus 5.5**. It is a fresh session in the same
  thread: the old conversation stays above a divider, workers, branches and checkouts stay as
  they are, the saved model becomes the running one.
- What the new session gets: the orchestrator's memory, charter and ledger (as Fresh session
  today); a thread gets a note written from its transcript, the plan, open asks, branch and PR.
- What it doesn't: the old session's tool output, reasoning and cache.
- **Save to memory first**, ticked by default (Fresh session's own box).
- Why a carry-over move isn't possible here, in the server's words, once and small.
- The task form: Start no longer greyed; the line says the orchestrator starts fresh as the task
  starts.
- The divider afterwards: "Fresh session on Claude Code · Opus 5.5 · 14:02", the previous
  session on hover.

## Out of scope

- Continue in… where it works (Claude Code and Codex on this machine): unchanged.
- Which account pays for a model, and the picker's words (#756).
- A new thread or a new checkout: the fresh session stays in the thread it replaces.

## Open questions

- Same thread, not a new one (default): keeps the transcript, the worker bindings and the
  checkout without moving anything.
- A thread's note is written by the new agent from the transcript (as limit mode does today),
  since the old session can't be asked for one where it can't hand over (default).
- Example names: the workspace "gram", running Codex · GPT-6.1-Sol on a gateway account, saved
  Claude Code · Opus 5.5.
