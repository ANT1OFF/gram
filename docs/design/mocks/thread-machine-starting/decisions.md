# A thread whose machine is starting: decisions

One line per review round: what was asked, what changed, in which version. The mock-review skill
keeps this; the build reads it with the approved version.

- v1 (2026-11-14): approved as drawn ("mock looks good"): the held message is a bubble in the
  conversation, and Try again is enough on the failure. The brief's assumptions stand: Try again is
  handed to the app Gram is mounted in, the first queued message is drawn as a message, the time
  counts from `awaitingMachine.since`, and a thread no machine came for sits under Needs you.
- Build (2026-11-14), deviations from v1, each because the real screen already has a way to say it:
  the sidebar's rows are one line, so a waiting row keeps its working dot and one that got no
  machine says "No machine" at its edge, with the mock's second line on the row's hover; a phone's
  header says the wait in its own line under the title ("Solo · Machine starting") in place of a
  chip; the messages after the first stay in the queue card as it is, under "Queued · waits for the
  machine", without the button that sends one now; with nobody to ask for a machine the failure has
  no Try again and says "What you sent is kept. To try again, start the thread again."
