// The runtimes as everything outside them reaches them: what a person (or an agent, for its
// lineage's person) does to a thread, the thread's owners must be (`host/ownership.ts`). Checked
// here, at what delivers to the agent, so no route around the RPC guard (a workspace's task, an
// answer over HTTP, a tool) reaches another person's thread. A notice or a system delivery is
// checked as well, against whoever's call it is made in: the server's own (no caller) passes, a
// person's or an agent's must be the thread's owners'. Work kept to be done later records who it
// was for and runs as them (a worker question's `closedFor`), so a retry can't make it the
// server's.

import { InvalidState, type Thread, type ThreadId, ThreadNotFound } from "@gram/contracts";
import * as Effect from "effect/Effect";
import {
  admitThread,
  keepsOwner,
  mayReachThread,
  MOVE_CHANGES_OWNER,
  sameOwner,
  NOT_YOUR_MACHINE,
  type OwnerOf,
} from "../host/ownership.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";

export const ownedRuntimes = (
  runtimes: ThreadRuntimesShape,
  getThread: (threadId: ThreadId) => Effect.Effect<Thread, unknown>,
  ownerOf: OwnerOf,
): ThreadRuntimesShape => {
  const admit = (threadId: ThreadId) => admitThread(getThread, ownerOf, threadId);
  /** For what can only say a thread isn't there: another person's is not, to this caller. */
  const admitOrAbsent = (threadId: ThreadId) =>
    Effect.flatMap(mayReachThread(getThread, ownerOf, threadId), (ok) =>
      ok ? Effect.void : Effect.fail(new ThreadNotFound({ threadId })),
    );
  return {
    ...runtimes,
    send: (threadId, ...rest) => Effect.andThen(admit(threadId), runtimes.send(threadId, ...rest)),
    sendOrJoin: (threadId, ...rest) =>
      Effect.andThen(admit(threadId), runtimes.sendOrJoin(threadId, ...rest)),
    steer: (threadId, ...rest) =>
      Effect.andThen(admit(threadId), runtimes.steer(threadId, ...rest)),
    sendNotice: (threadId, ...rest) =>
      Effect.andThen(admit(threadId), runtimes.sendNotice(threadId, ...rest)),
    requestSystemDelivery: (threadId, ...rest) =>
      Effect.andThen(admitOrAbsent(threadId), runtimes.requestSystemDelivery(threadId, ...rest)),
    // A thread keeps whose it is wherever it goes: onto a machine of the same person's, or of no
    // one's from no one's. A route that moves one checks first and refuses with a reason; this is
    // the floor under every route, so a move that would change the owner never happens.
    moveCheckout: (threadId, checkout) =>
      Effect.gen(function* () {
        yield* admitOrAbsent(threadId);
        const thread = yield* getThread(threadId).pipe(Effect.orElseSucceed(() => undefined));
        if (thread !== undefined && !keepsOwner(ownerOf, thread, checkout))
          return yield* Effect.die(new InvalidState({ message: MOVE_CHANGES_OWNER, threadId }));
        return yield* runtimes.moveCheckout(threadId, checkout);
      }),
    // The same floor under a move off a machine that is gone (an embedder's): whoever asks must
    // reach the thread, and what `prepare` places it on must be of the same owner.
    relocate: (threadId, plan) =>
      Effect.andThen(
        admitOrAbsent(threadId),
        runtimes.relocate(threadId, {
          ...plan,
          prepare: Effect.flatMap(plan.prepare, (checkout) =>
            sameOwner(ownerOf, plan.from, checkout)
              ? Effect.succeed(checkout)
              : Effect.die(new InvalidState({ message: MOVE_CHANGES_OWNER, threadId })),
          ),
        }),
      ),
    interrupt: (threadId) => Effect.andThen(admitOrAbsent(threadId), runtimes.interrupt(threadId)),
    stopAtToolBoundary: (threadId) =>
      Effect.andThen(admitOrAbsent(threadId), runtimes.stopAtToolBoundary(threadId)),
    // Before the request is taken: an answer refused here leaves it open for its owner.
    respond: (threadId, ...rest) =>
      Effect.andThen(admit(threadId), runtimes.respond(threadId, ...rest)),
    // Each answer on its own: one refused leaves the others to be given, in the order asked.
    respondMany: (answers) =>
      Effect.gen(function* () {
        const reachable: Array<boolean> = [];
        for (const each of answers)
          reachable.push(yield* mayReachThread(getThread, ownerOf, each.threadId));
        const allowed = answers.filter((_, index) => reachable[index]);
        const given = allowed.length === 0 ? [] : yield* runtimes.respondMany(allowed);
        let next = 0;
        return answers.map((each, index) =>
          reachable[index]
            ? (given[next++] ?? { threadId: each.threadId, requestId: each.requestId, ok: false })
            : {
                threadId: each.threadId,
                requestId: each.requestId,
                ok: false,
                error: NOT_YOUR_MACHINE,
              },
        );
      }),
    stopTask: (threadId, ...rest) =>
      Effect.andThen(admit(threadId), runtimes.stopTask(threadId, ...rest)),
    setMode: (threadId, ...rest) =>
      Effect.andThen(admit(threadId), runtimes.setMode(threadId, ...rest)),
    setModel: (threadId, ...rest) =>
      Effect.andThen(admit(threadId), runtimes.setModel(threadId, ...rest)),
    close: (threadId, ...rest) =>
      Effect.andThen(admit(threadId), runtimes.close(threadId, ...rest)),
    reorderQueue: (threadId, ...rest) =>
      Effect.andThen(admit(threadId), runtimes.reorderQueue(threadId, ...rest)),
    steerQueued: (threadId, ...rest) =>
      Effect.andThen(admit(threadId), runtimes.steerQueued(threadId, ...rest)),
    rewind: (threadId, ...rest) =>
      Effect.andThen(admit(threadId), runtimes.rewind(threadId, ...rest)),
    fork: (plan, options) => Effect.andThen(admit(plan.source.id), runtimes.fork(plan, options)),
    restartSession: (threadId, ...rest) =>
      Effect.andThen(admit(threadId), runtimes.restartSession(threadId, ...rest)),
    startSession: (threadId) => Effect.andThen(admit(threadId), runtimes.startSession(threadId)),
    switchAgent: (threadId, ...rest) =>
      Effect.andThen(admit(threadId), runtimes.switchAgent(threadId, ...rest)),
  };
};
