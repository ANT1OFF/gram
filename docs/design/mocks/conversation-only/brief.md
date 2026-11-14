# Conversation only

Written by the design-brief skill before the first version. Keep it short; it is what the mock is
checked against.

## Problem

"I want a mode where we don't see the commands and the needless fluff." A thread's transcript
shows every tool call, command and fold row between the agent's words. A reader who only wants
what the agent said, what it is working through and what it needs has to read around the work.

## Who and where

Anyone reading a thread, in the thread view and in the orchestrator's chat, in the desktop app
and where the web app is mounted in another app. It is optional and off until switched on.

## Must show

- What stays: the user's messages, the agent's text, the task list, questions and approvals,
  images, published pages and files, errors.
- What goes: tool calls and runs, commands, reasoning, the turn's fold row.
- A turn in progress: what says the agent is working when its calls aren't drawn.
- A finished turn: whether anything marks the work that was done, and how to reach it.
- Where the switch is, and what it looks like on and off.

## Out of scope

- Quiet, the window mode that shows one ask at a time. This is a different thing with its own name.
- Changing what a finished turn folds today when the mode is off.
- The trace and the side panels, which keep showing everything.

## Open questions

- Name: "Conversation only" (default). "Quiet" is taken.
- Scope: one switch for every thread in the window, remembered (default), not per thread.
- An approval or a failed call still shows in the mode (default): it needs the reader.
- All of the agent's text shows, not only a turn's last words (default).
