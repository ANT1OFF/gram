// Machines started for one person (`embedding/on-demand.ts`): who may reach one.
//
// Ownership is the machine's alone. A thread is its machine's owner's; nothing is inherited from
// an orchestrator or a spawner. One rule, `mayReach`, decides, and it is asked at the few places
// every path to a machine passes:
//
// 1. Where a host or a session is resolved: `WorkerHosts.get` and the session lookup
//    (`ownedMachines`), which every terminal, file, git call and session opening goes through,
//    and the runtimes' deliveries to a session already open (`runtime/owned-runtimes.ts`).
// 2. Where work is kept to be done later: `durable-work.ts` records who it is for when it is
//    written (`recordActor`) and runs every attempt, a retry included, as them (`asRecorded`).
//
// The calls are told who they are made for (`RoutedFor`): every RPC as its signed-in person, and
// every agent tool call as its own thread's machine's owner (`asThreadOwner`). Threads in one
// orchestration have one owner: a link between them (a spawn, a join, a move) is made only
// between machines of the same person's, or of no one's (`sameOwner`), so a workspace's
// orchestrator and its workers never span two people.

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

/** What a link between threads on two people's machines (or one person's and no one's) is told. */
export const OWNERS_DIFFER =
  "Threads that work together run on machines of the same person's, or of no one's.";

/**
 * Who a call that may reach a machine is made for: set around every RPC (`rpc/actor-guard.ts`),
 * as the signed-in person, or nobody without fronted sign-in; around every agent's tool call
 * (`app-tools/registry.ts`), as its thread's machine's owner; and around every attempt at kept
 * work, as who it was written for. Absent only for the server's own work.
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
 * The rule. Whether this fiber's caller may reach `hostId`: a machine nobody owns, the server's
 * own work, or its owner's call. Anyone else's, and a call with no signed-in person, may not.
 */
export const mayReach = (ownerOf: OwnerOf, hostId: HostId): Effect.Effect<boolean> => {
  const owner = ownerOf(hostId);
  if (owner === undefined) return Effect.succeed(true);
  return Effect.map(currentCaller, (caller) => caller === undefined || caller.person === owner);
};

/**
 * `reach` (a machine's host by id), refused for a machine this fiber's caller may not reach: the
 * door every route to a joined machine goes through (`WorkerHosts.get`, the session lookup).
 */
export const ownedMachines =
  <H>(ownerOf: OwnerOf, reach: (id: HostId) => Effect.Effect<H, HostUnavailable>) =>
  (id: HostId): Effect.Effect<H, HostUnavailable> =>
    Effect.flatMap(mayReach(ownerOf, id), (ok) =>
      ok ? reach(id) : Effect.fail(new HostUnavailable({ hostId: id, message: NOT_YOUR_MACHINE })),
    );

/** Every checkout a thread works in: its own, the one it follows now, and its other repos'. */
const checkoutsOf = (thread: Thread) => [
  thread.checkout,
  ...(thread.currentCheckout === undefined ? [] : [thread.currentCheckout]),
  ...(thread.extraCheckouts ?? []),
];

/** Whose a thread is: its machine's owner, where it is on a machine started for someone. */
export const threadOwner = (
  ownerOf: OwnerOf,
  thread: Pick<Thread, "checkout" | "currentCheckout">,
) => ownerOf(hostOf(effectiveCheckout(thread)));

/**
 * The rule for a thread: whether this fiber's caller may reach every machine it works on
 * (`mayReach`). A thread that isn't stored has no machine, and is left to its caller's not-found.
 */
export const mayReachThread = (
  getThread: (threadId: ThreadId) => Effect.Effect<Thread, unknown>,
  ownerOf: OwnerOf,
  threadId: ThreadId,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    // The server's own work reaches everything, and reads nothing to say so.
    if ((yield* currentCaller) === undefined) return true;
    const thread = yield* getThread(threadId).pipe(Effect.orElseSucceed(() => undefined));
    if (thread === undefined) return true;
    for (const checkout of checkoutsOf(thread))
      if (!(yield* mayReach(ownerOf, hostOf(checkout)))) return false;
    return true;
  });

/** Refused, with why, unless this fiber's caller may reach `threadId` (`mayReachThread`). */
export const admitThread = (
  getThread: (threadId: ThreadId) => Effect.Effect<Thread, unknown>,
  ownerOf: OwnerOf,
  threadId: ThreadId,
): Effect.Effect<void, InvalidState> =>
  Effect.flatMap(mayReachThread(getThread, ownerOf, threadId), (ok) =>
    ok ? Effect.void : Effect.fail(new InvalidState({ message: NOT_YOUR_MACHINE, threadId })),
  );

/**
 * `effect` as a call made for `threadId`'s machine's owner, whoever's fiber runs it: an agent's
 * tool call, and kept work done for a thread. Never from what an agent says; no one's for a
 * thread on no one's machine, or not stored.
 */
export const asThreadOwner =
  (
    getThread: (threadId: ThreadId) => Effect.Effect<Thread, unknown>,
    ownerOf: OwnerOf,
    threadId: ThreadId,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(getThread(threadId).pipe(Effect.orElseSucceed(() => undefined)), (thread) =>
      Effect.provideService(effect, RoutedFor, {
        person: thread === undefined ? undefined : threadOwner(ownerOf, thread),
      }),
    );

/**
 * Whether two places are of one owner: machines of the same person's, or both of no one's. The
 * one test for a link between threads (a worker under its orchestrator, a join, a move), so an
 * orchestration never spans two people and a thread never changes owner.
 */
export const sameOwner = (
  ownerOf: OwnerOf,
  a: { readonly hostId?: HostId | undefined },
  b: { readonly hostId?: HostId | undefined },
): boolean => ownerOf(hostOf(a)) === ownerOf(hostOf(b));

/** What a move that would hand a thread to another owner, or to none, is told. */
export const MOVE_CHANGES_OWNER =
  "A thread moves only onto a machine started for the same person as the one it is on.";

/** Whether moving `thread` into `checkout` keeps whose it is (`sameOwner`). */
export const keepsOwner = (
  ownerOf: OwnerOf,
  thread: Pick<Thread, "checkout" | "currentCheckout">,
  checkout: { readonly hostId?: HostId | undefined },
): boolean => sameOwner(ownerOf, effectiveCheckout(thread), checkout);

/**
 * Who kept work is for, as it is stored with it: the caller it was written in. `{}` is a caller
 * with no signed-in person, which reaches no one's machine. Absent: the server's own work.
 */
export interface RecordedActor {
  readonly person?: string;
}

/** Who work written now is for (`RecordedActor`): this fiber's caller, absent for the server. */
export const recordActor: Effect.Effect<RecordedActor | undefined> = Effect.map(
  currentCaller,
  (caller) =>
    caller === undefined ? undefined : caller.person === undefined ? {} : { person: caller.person },
);

/**
 * `effect` as the call kept work was written in (`recordActor`), whichever fiber attempts it: a
 * person's work as theirs, the server's as the server's, never as whoever's call a retry is in.
 */
export const asRecorded =
  (actor: RecordedActor | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.provideService(RoutedFor, actor === undefined ? undefined : { person: actor.person }),
      Effect.provideService(ActingPerson, actor?.person),
    );

/**
 * A recorded actor as kept with work that has no other place for "the server's own": `"server"`
 * for that, else the caller (`RecordedActor`). Work kept before actors were recorded has none,
 * and is taken as a caller with no signed-in person (`fromStored`): it reaches no one's machine
 * but the unowned, as before.
 */
export type StoredActor = RecordedActor | "server";

/** `recordActor` as kept (`StoredActor`). */
export const storedActor: Effect.Effect<StoredActor> = Effect.map(
  recordActor,
  (actor) => actor ?? "server",
);

/** The actor kept work is attempted as (`asRecorded`), from what was stored with it. */
export const fromStored = (stored: StoredActor | undefined): RecordedActor | undefined =>
  stored === "server" ? undefined : (stored ?? {});
