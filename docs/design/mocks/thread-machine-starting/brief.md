# A thread whose machine is starting

## Problem

A thread can now be started before its machine: whoever runs Gram's machines starts one for each
new thread, and the thread is stored at once with the first message in its queue
([thread profiles](../../../THREAD_PROFILES.md#before-its-machine)). Until the machine is named
the thread carries `awaitingMachine`. Today's thread view knows nothing of it: the first message
shows only as a queued item, and the machine chip reads "on a machine that is no longer joined",
which is wrong and alarming. If no machine comes, nothing on the screen says so.

## Who and where

A person who has just sent the first message of a new thread, in the thread view (desktop and
phone widths), and in the sidebar row of that thread. Mostly inside another app that mounts
Gram's web app.

## Must show

- Starting: the person's message, readable as theirs and as not yet sent; that the machine is
  starting and for how long; a composer that still takes messages, which wait too.
- No machine came: a readable failure in Gram's sentence or the platform's own
  (`awaitingMachine.failed.message`), that nothing was lost, and Try again.
- Trying again: back to starting, with the wait counted from the new try.
- Placed: the same thread a moment later, so the change between the two can be judged.
- The sidebar row in each state.

## Out of scope

- Starting or choosing a machine: Gram starts none. Try again asks whoever does.
- Threads in repositories: they are never started before their machine.
- The new-thread form that led here.

## Open questions

- Assumed: Try again is handed to the app Gram is mounted in (a mount option), since Gram has no
  call that starts a machine. With no handler, the button is absent and the line says to start the
  thread again.
- Assumed: the first queued message is drawn as a message in the conversation while the thread
  waits, although it is stored in the queue; later ones stay queue items above the composer.
- Assumed: the elapsed time counts from `awaitingMachine.since`.
- Open: whether a waiting thread belongs under Working or Needs you in the sidebar once it has
  failed. Drawn under Needs you.
