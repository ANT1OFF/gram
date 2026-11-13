# Run trace

Written by the design-brief skill before the first version. Keep it short; it is what the mock is
checked against.

## Problem

"I want full observability on what my agents do." Today a run is read as a conversation: tool
cards folded under each turn, a small run timeline popover with a turn's tool calls as bars, a
strip per subagent, and token counts per reply. Nothing shows a whole run as one picture: what
happened in what order, what ran side by side, where the time and the money went, what failed, and
what a worker did underneath.

## Who and where

Someone who sent an agent off and comes back to check it, or to find out why it was slow, costly
or wrong. They arrive from a thread (the turn's "Run timeline" button, the thread's panel) and, in
an app that mounts the web app, from that app's list of runs.

## Must show

- Steps in order with start, duration and outcome: model calls, tool calls, approvals and
  questions (time spent waiting on a person), errors.
- Nested workers: a subagent's own model and tool calls under the call that started it.
- Calls that ran side by side.
- Totals: wall time, share of it in the model, in tools and waiting on a person, tokens, cost.
- One step's detail: input, output or error text, model and tokens of a model call.
- A run still going: the last bar grows, the view follows.
- Data that exists today: `toolTimes` per tool call, `createdAt`, `model` and `usage` per reply,
  `parentToolUseId` on a subagent's messages, `SubagentUsage`, approval and question requests,
  `turnEnd`. Model calls are not timed one by one today; the gaps between tool calls are the
  model, which is how the mock draws them.

## Out of scope

- A list of all runs across threads (an embedding app has its own).
- Sandbox-level events (network, files, processes) and policy decisions an embedding app records;
  the view leaves room for extra step kinds, the mock does not draw them.
- Phone layout: after a direction is picked.

## Open questions

- A trace covers one turn (one send and everything it caused). Default: yes, with a turn picker;
  the whole thread is a later step.
- It lives in the thread, not on a page of its own. Default: yes.
