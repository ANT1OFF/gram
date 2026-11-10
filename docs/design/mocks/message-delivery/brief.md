# Message delivery while a turn runs: brief

## Problem

"Can we for user messages also offer to steer, queue or interrupt somehow?" While a turn runs,
the composer's round button queues by default (Enter and ⌘↵ queue); ⌘-click or holding ⌘ turns it
into Steer, and an empty composer's button is Stop (⌘.). Interrupting means Stop, wait, then send:
two steps. Nothing on a sent message says how it went in.

Since #363 a steer cancels nothing (it lands after the tool call under way), so it can be the
default, and an interrupt (stop now and answer this) exists in the runtime.

## Who and where

Anyone typing into a thread that is working: the thread's composer on desktop, and the same
composer in the phone layout (no hover, no modifier keys).

## Must show

- The three modes, as icons with words on hover: **Steer** (default; after the current tool
  call, cancels nothing), **Queue** (after the turn), **Interrupt** (stops now, cuts off tool
  calls).
- How each is picked from the keyboard, and with the pointer.
- The phone layout.
- On the sent message: steered, queued and waiting (cancellable, the existing queue card), or
  interrupted.

## Out of scope

- The composer with no turn running (it sends, as today).
- The queue card's own actions (edit, reorder, steer now, remove) beyond what is shown.
- Orchestrator `send_message` modes, done in #363.

## Open questions (defaults picked)

- **Keys:** Enter steers, ⌥↵ queues, ⌘. with a draft interrupts (stop and send this); ⌘. on an
  empty composer stays Stop. Under the "⌘↵ sends" setting, ⌘↵ steers and ⌥⌘↵ is already "send and
  start a new draft", so queue there is ⌥↵ too. ⇧⌘↵ is taken (maximize pane).
- **Default:** Steer while running, not Queue as today.
- **Codex:** it can't be interrupted for a message; Interrupt there steers, and its tooltip says so.
- **Sticky:** the pick applies to one message; the next one is a steer again.
