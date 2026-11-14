# A thread whose machine is starting: handoff

[Brief](brief.md) · [Decisions](decisions.md) · [Approved page](v1.html)

## Target

`v1.html`, every board:

- **Thread**, in its four states. _Starting_: the first message that waits as the person's own
  bubble with a dashed edge, "14:02 · sent when the machine has started" under it, then
  "Starting this thread's machine · usually under a minute" with the elapsed time; the header's
  chip says "machine starting". _No machine_: the same bubble with "not sent yet, and kept", the
  failure with its sentence (Gram's "No machine started for this thread." or the platform's own,
  `awaitingMachine.failed.message`), "What you sent is kept, and goes once a machine has started."
  and Try again; the chip says "no machine". _Trying again_: "Starting a machine again · the first
  didn't start", counted from the new try. _Placed_: the thread as any other, which needs nothing
  new.
- **Sidebar rows**: a waiting thread with the working ones, one no machine came for under Needs
  you, and a hover that says what waits and since when, never "no longer joined".
- **Thread on a phone**: the same conversation in one column, Try again under the failure's words.

## Decisions

- The held message is a bubble in the conversation, though it is stored in the queue; the
  messages after it stay queue items over the prompt box.
- Try again is handed to the app Gram is mounted in (`shell.machines.startAgain`): Gram starts no
  machine, and its page can't begin the wait again itself. Without a handler there is no button.
- The elapsed time counts from `awaitingMachine.since`.
- A thread no machine came for sits under Needs you.

## Parts

| In the mock                    | In the code                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `.tm-chip`                     | the pane header's machine chip (`machine-chip.tsx`, `AwaitingMachineChip`)                      |
| `.tm-bubble.held`, `.tm-under` | the user's `Message` / `MessageContent` with a dashed edge (`awaiting-machine.tsx`)             |
| `.tm-status`, `.spinner`       | a `role="status"` line with `Spinner` (`awaiting-machine.tsx`)                                  |
| `.callout.danger`, `.btn`      | `alert` (destructive) and `button` (`awaiting-machine.tsx`)                                     |
| `.tm-queued`                   | the queue card as it is (`queue-list.tsx`), under the wait's heading                            |
| `.tm-slab`                     | the composer, with the wait's placeholder (`thread-view.tsx`)                                   |
| `.tm-row`                      | the sidebar's rows by `rowStatus` (`sidebar/status.ts`) and their group (`sidebar/grouping.ts`) |

Nothing is new to the kit.

## Deviations allowed

Real data lengths, the real header (its status glyph, its menu), the real queue card and its
controls, and the sidebar's one-line rows. Not the states, their order, or their words: every
string is in `WAIT_WORDS` (`awaiting-machine-model.ts`), and an embedding app's tests may read
them.

## Gaps

None bracketed in the page. The machine's name ("on notes-7f3a") and the agent's first line
("Reading AGENTS.md") in the placed state are sample data.
