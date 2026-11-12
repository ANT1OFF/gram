// Machines started for one person (`embedding/on-demand.ts`): who may reach one. Placement
// (`headless.ts`) is one way onto a machine; a terminal, a fork, a session, a file read and a git
// call are others, so the rule lives here and every route asks it: `WorkerHosts.get` for anything
// that reaches the machine, `admitHost` for what records a thread there without reaching it.

import {
  effectiveCheckout,
  hostOf,
  type HostId,
  HostUnavailable,
  InvalidState,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { ActingPerson } from "../embedding/person.ts";

/** What a person is told who reaches for a machine started for someone else. */
export const NOT_YOUR_MACHINE = "That machine was started for someone else.";

/**
 * Who a call that may reach a machine is made for: set around every RPC (`rpc/actor-guard.ts`),
 * as the signed-in person, or nobody without fronted sign-in; and around every agent's tool call
 * (`app-tools/registry.ts`), as the person its thread's lineage is for (`lineageOwner`). Absent
 * for the server's own work on a thread already placed (a session it reopens, a watch it keeps).
 */
export interface Caller {
  readonly person: string | undefined;
}

export const RoutedFor = Context.Reference<Caller | undefined>("@gram/server/RoutedFor", {
  defaultValue: () => undefined,
});

/** This fiber's caller: `RoutedFor`, else the acting person where one is known. */
export const currentCaller: Effect.Effect<Caller | undefined> = Effect.gen(function* () {
  const routed = yield* RoutedFor;
  if (routed !== undefined) return routed;
  const person = yield* ActingPerson;
  return person === undefined ? undefined : { person };
});

/** The person what is placed now is for, where one is known. */
export const callerPerson: Effect.Effect<string | undefined> = Effect.map(
  currentCaller,
  (caller) => caller?.person,
);

/** The person a machine was started for, when it was started for one. */
export type OwnerOf = (hostId: HostId) => string | undefined;

/** Owners as the joined machines record them. */
export const ownersOf =
  (
    machines:
      | {
          readonly list: () => ReadonlyArray<{
            readonly id: string;
            readonly owner?: string | undefined;
          }>;
        }
      | undefined,
  ): OwnerOf =>
  (hostId) =>
    machines?.list().find((machine) => machine.id === hostId)?.owner;

/**
 * Whether this fiber's caller may reach `hostId`: a machine nobody owns, the server's own work, or
 * its owner's call. Anyone else's, and an RPC with no signed-in person, may not.
 */
export const mayReach = (ownerOf: OwnerOf, hostId: HostId): Effect.Effect<boolean> => {
  const owner = ownerOf(hostId);
  if (owner === undefined) return Effect.succeed(true);
  return Effect.map(currentCaller, (caller) => caller === undefined || caller.person === owner);
};

/** Refused, with why, unless this fiber's caller may reach `hostId` (`mayReach`). */
export const admitHost = (ownerOf: OwnerOf, hostId: HostId): Effect.Effect<void, InvalidState> =>
  Effect.flatMap(mayReach(ownerOf, hostId), (ok) =>
    ok ? Effect.void : Effect.fail(new InvalidState({ message: NOT_YOUR_MACHINE })),
  );

/**
 * `reach` (a machine's host by id), refused for a machine this fiber's caller may not reach: the
 * one door every route to a joined machine goes through (`WorkerHosts.get`).
 */
export const ownedMachines =
  <H>(ownerOf: OwnerOf, reach: (id: HostId) => Effect.Effect<H, HostUnavailable>) =>
  (id: HostId): Effect.Effect<H, HostUnavailable> =>
    Effect.flatMap(mayReach(ownerOf, id), (ok) =>
      ok ? reach(id) : Effect.fail(new HostUnavailable({ hostId: id, message: NOT_YOUR_MACHINE })),
    );

/** How far up a lineage is followed: further than any orchestration nests. */
const LINEAGE_DEPTH = 32;

/**
 * The person a thread's work is for, from what the server itself recorded: the owner of the machine
 * it works on, else its spawner's, up its lineage. Never from what an agent says. `undefined` for a
 * thread on no one's machine, all the way up, and for one that isn't stored.
 */
export const lineageOwner = (
  getThread: (threadId: ThreadId) => Effect.Effect<Thread, unknown>,
  ownerOf: OwnerOf,
  threadId: ThreadId,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const seen = new Set<ThreadId>();
    let at: ThreadId | undefined = threadId;
    while (at !== undefined && !seen.has(at) && seen.size < LINEAGE_DEPTH) {
      seen.add(at);
      const thread: Thread | undefined = yield* getThread(at).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (thread === undefined) return undefined;
      const owner = ownerOf(hostOf(effectiveCheckout(thread)));
      if (owner !== undefined) return owner;
      at = thread.spawnedBy?.threadId;
    }
    return undefined;
  });

/** `effect` as a call made for `threadId`'s lineage (`lineageOwner`), whoever's fiber runs it. */
export const forThread =
  (
    getThread: (threadId: ThreadId) => Effect.Effect<Thread, unknown>,
    ownerOf: OwnerOf,
    threadId: ThreadId,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(lineageOwner(getThread, ownerOf, threadId), (person) =>
      Effect.provideService(effect, RoutedFor, { person }),
    );
