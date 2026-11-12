// The runtimes as everything outside them reaches them: what a person (or an agent, for its
// lineage's person) does to a thread, the thread's owners must be (`host/ownership.ts`). Checked
// here, at what delivers to the agent, so no route around the RPC guard (a workspace's task, an
// answer over HTTP, a tool) reaches another person's thread. The runtimes' own work, and a notice
// the server sends, carry no caller and pass.

import type { Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { admitThread, mayReachThread, NOT_YOUR_MACHINE, type OwnerOf } from "../host/ownership.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";

export const ownedRuntimes = (
  runtimes: ThreadRuntimesShape,
  getThread: (threadId: ThreadId) => Effect.Effect<Thread, unknown>,
  ownerOf: OwnerOf,
): ThreadRuntimesShape => {
  const admit = (threadId: ThreadId) => admitThread(getThread, ownerOf, threadId);
  return {
    ...runtimes,
    send: (threadId, ...rest) => Effect.andThen(admit(threadId), runtimes.send(threadId, ...rest)),
    sendOrJoin: (threadId, ...rest) =>
      Effect.andThen(admit(threadId), runtimes.sendOrJoin(threadId, ...rest)),
    steer: (threadId, ...rest) =>
      Effect.andThen(admit(threadId), runtimes.steer(threadId, ...rest)),
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
