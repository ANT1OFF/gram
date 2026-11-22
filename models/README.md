# Models

TLA+ models of protocols where a bug hides in an interleaving. TLC, the model checker, runs a
model on every order of its steps up to a bound and prints the shortest behaviour that breaks a
property. It checks the model, not the code, so each action names the function it stands for.

To check one, with Java 11 or later and the TLC jar (`tla2tools.jar`, v1.7.4, from the
[TLA+ releases](https://github.com/tlaplus/tlaplus/releases)):

```sh
cd models/thread-move
java -cp tla2tools.jar tlc2.TLC -config ThreadMove.cfg ThreadMove.tla
```

## Thread moves

`thread-move/ThreadMove.tla`: a thread moved to another server (`exportThread`, `settleThread` in
`packages/server/src/transfer/thread-transfer.ts`) while a person can still send to the copy here
(`sendInput`, `packages/server/src/runtime/message-queue.ts`). `ThreadMove.cfg` checks
`NothingLeftBehind`: once the copy here is settled, every message and edit on it went in the
bundle and nothing runs on it.

Findings, both fixed on 22 November 2026; each `findings/<name>.cfg` is the code before:

- `ExportWindow.cfg`: a message sent while the export pushed the thread's edits. The export read
  the thread idle, then pushed, then read the history and stamped `exportedAt`. A turn that started
  and ended in between had its message and reply in the bundle but not its edits, and settling let
  it through, because the turn touched `lastActivityAt` before the stamp. Now the export stamps
  first, and settling refuses activity at or after the stamp (the clock counts milliseconds, so
  the same one counts). `thread-transfer.test.ts` ("a turn that starts while the thread is
  exported keeps it from settling") holds it.
- `SendDuringSettle.cfg`: a message that landed after settling rested the session but before it
  wrote `transferredTo`. It was kept and its turn ran on a copy now archived. Now
  `restSessionThen` reads the thread again and writes the move under the thread's lock, where a
  send waits.

## Held briefs

`held-briefs/HeldBriefs.tla`: a worker brief held back (a usage limit, a full slot, the spawn
breaker) and released later (`releaseDue`, `releaseHeldBrief` in
`packages/server/src/orchestration/service/held-spawns.ts`, then `spawnFor`), while the server
may stop between any two steps and releases every due brief again when it starts.
`HeldBriefs.cfg` checks `NoneDropped`, that a held brief is never dropped: with the server up and
no release under way, it is still held or it reached a worker. It also checks `OneWorker`, that
one brief makes at most one worker.

Finding, fixed on 22 November 2026; `findings/NoneDropped.cfg` is the code before:

- A release took the brief out of the outbox before it spawned the worker. A server that stopped
  in between (a quit, a crash) lost the brief: nothing held it, no worker had it, and the
  orchestrator, told it was held, waited for a spawn that never came. Now the claim keeps the
  brief and gives it a request id of its own when it has none (`held-outbox.ts`). It leaves the
  outbox only when its release ends, so the next start releases it again, and that release
  finishes the worker it half made rather than make a second. Keeping the brief without the
  request id breaks `OneWorker`. `held-briefs.test.ts` ("a release cut short leaves the brief
  held, and the next release makes one worker") holds it.
