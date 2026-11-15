# Composer while an agent works: brief

## Problem

"I am a bit unhappy with the UI for interrupt, steer and queue when an agent is working. Can we
do another pass and make it more clear that the user has options?" Today, while a turn runs, the
empty composer says "Queue a message… (/ for commands, @ for files)" (though ↵ steers) and shows
only the mic, the context meter and Stop. The three ways in (the approved
[message-delivery](../message-delivery/handoff.md) split button) appear only once there is a
draft, behind a small chevron.

## Who and where

Anyone with a working thread open: the thread's composer on desktop and on a phone.

## Must show

- That steer, queue and interrupt exist, before the user types.
- What ↵ does now, in words, and how to pick the other two (pointer and keys).
- Stop with no message.
- The phone layout (no hover, no modifier keys).

## Out of scope

- The keys themselves (↵ steer, ⌥↵ queue, ⌘. interrupt, ⌘. alone stops), the sent-message marks
  and the queue card, all from message-delivery.
- The composer at rest.

## Open questions (defaults picked)

- **Sticky:** a pick holds for one message; the next is a steer again.
- **Agents that can't steer** (no `steer` capability): the composer queues, and says "Queue" in
  the same place, with no choice offered.
