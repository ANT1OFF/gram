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
// between machines of the same person's, of the same shared scope, or of no one's in particular
// (`sameOwner`), so a workspace's orchestrator and its workers never span two people.
//
// Whose a machine is (`HostOwner`) is fail-closed. A machine an embedder started on demand names
// whom it is for: one person (`owner`), or an explicit shared scope with the people it admits
// (`shared`). One started on demand that names neither (registered before that was required) is
// reached by the server's own work alone. Only a machine that isn't on demand at all (this one, a
// machine a person joined with a link, a provisioned host registered with no kind) is anyone's,
// as before. The server's own work is a capability (`SERVER_WORK`), given at the server's root and
// to kept work written by it, never read from the absence of a caller: a call nobody says is for
// anyone reaches only what is anyone's.
//
// One thread has no machine yet: one started before its machine (`Thread.awaitingMachine`). Until
// it is placed it is reached only by whoever it was started by, where the start named a person
// (`mayReachThread`), and it is placed only on a machine that admits them, or one that is
// anyone's (`mayPlaceAwaited`).

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
 * A machine an embedder started for something shared rather than for one person: the people it
 * admits, by the stable subject each signs in with, and the scope it is shared in. Machines of one
 * scope count as one owner's (`sameOwner`), so a thread moves between them and an agent on one
 * reaches the others; nobody outside `people` reaches any of them, and an empty `people` admits
 * no one but the server's own work and the agents of that scope.
 */
export interface SharedHost {
  readonly scope: string;
  readonly people: ReadonlyArray<string>;
}

/** A machine started on demand that names no one: the server's own work alone reaches it. */
export const NOBODY: { readonly nobody: true } = Object.freeze({ nobody: true });

/**
 * Whose a machine is: a person's (their subject), a shared scope's, nobody's (`NOBODY`, on demand
 * and naming neither), or, `undefined`, anyone's: a machine that isn't on demand at all.
 */
export type HostOwner = string | { readonly shared: SharedHost } | typeof NOBODY | undefined;

/** What a machine's record says of whom it is for (`HostOwner`). */
export const ownerOfMachine = (machine: {
  readonly owner?: string | undefined;
  readonly onDemand?: string | undefined;
  readonly shared?: SharedHost | undefined;
}): HostOwner =>
  machine.owner !== undefined
    ? machine.owner
    : machine.shared !== undefined
      ? { shared: machine.shared }
      : machine.onDemand !== undefined
        ? NOBODY
        : undefined;

/** The person a machine is for, where it is one person's. */
export const ownerPerson = (owner: HostOwner): string | undefined =>
  typeof owner === "string" ? owner : undefined;

/**
 * Who a call that may reach a machine is made for: set around every RPC (`rpc/actor-guard.ts`),
 * as the signed-in person, or nobody without fronted sign-in; around every person's HTTP request
 * (`http/server.ts`); around every agent's tool call (`app-tools/registry.ts`), as its thread's
 * machine's owner or shared scope; and around every attempt at kept work, as who it was written
 * for. The server's own work is `SERVER_WORK`. Absent: nobody said, which reaches only a machine
 * that is anyone's.
 */
export interface Caller {
  readonly person: string | undefined;
  /** The shared scope an agent on a shared machine works in (`SharedHost.scope`). */
  readonly scope?: string | undefined;
}

/**
 * The server's own work: the one caller that reaches every machine. A capability by identity, not
 * a shape: only this value grants it. Given at the server's root (`main.ts`), so what the server
 * does by itself has it, and taken off every person's request and call, which name their person.
 */
export const SERVER_WORK: Caller = Object.freeze({ person: undefined });

/** Whether `caller` is the server's own work (`SERVER_WORK`). */
export const isServerWork = (caller: Caller | undefined): boolean => caller === SERVER_WORK;

/** `effect` as the server's own work (`SERVER_WORK`), whoever's fiber runs it. */
export const asServerWork = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, RoutedFor, SERVER_WORK);

export const RoutedFor = Context.Reference<Caller | undefined>("@gram/server/RoutedFor", {
  defaultValue: () => undefined,
});

/**
 * This fiber's caller: `RoutedFor`, else the acting person where one is known. A person acting
 * narrows the server's own work it runs under: their call is theirs, never the server's.
 */
export const currentCaller: Effect.Effect<Caller | undefined> = Effect.gen(function* () {
  const routed = yield* RoutedFor;
  if (routed !== undefined && !isServerWork(routed)) return routed;
  const person = yield* ActingPerson;
  return person === undefined ? routed : { person };
});

/** The person what is placed now is for, where one is known. */
export const callerPerson: Effect.Effect<string | undefined> = Effect.map(
  currentCaller,
  (caller) => caller?.person,
);

/** Whom a machine was started for (`HostOwner`): `undefined` for a machine that is anyone's. */
export type OwnerOf = (hostId: HostId) => HostOwner;

/** Owners as the joined machines record them. */
export const ownersOf =
  (
    machines:
      | {
          readonly list: () => ReadonlyArray<{
            readonly id: string;
            readonly owner?: string | undefined;
            readonly onDemand?: string | undefined;
            readonly shared?: SharedHost | undefined;
          }>;
        }
      | undefined,
  ): OwnerOf =>
  (hostId) => {
    const machine = machines?.list().find((each) => each.id === hostId);
    return machine === undefined ? undefined : ownerOfMachine(machine);
  };

/**
 * Whether a person's or an agent's call (never the server's own) is one `owner` admits: its
 * person, for a person's machine; one of its people, or an agent of its scope, for a shared one.
 * A machine on demand that names no one admits no call; one that is anyone's, every call.
 */
export const admitsCall = (owner: HostOwner, caller: Caller | undefined): boolean => {
  if (owner === undefined) return true;
  if (caller === undefined) return false;
  if (typeof owner === "string") return caller.person !== undefined && caller.person === owner;
  if ("shared" in owner)
    return (
      (caller.person !== undefined && owner.shared.people.includes(caller.person)) ||
      (caller.scope !== undefined && caller.scope === owner.shared.scope)
    );
  return false;
};

/**
 * The rule. Whether this fiber's caller may reach `hostId`: a machine that is anyone's, the
 * server's own work (`SERVER_WORK`), or a call its owner admits (`admitsCall`). Anyone else's, a
 * call nobody said was for anyone, and every person's call to a machine that names no one, may not.
 */
export const mayReach = (ownerOf: OwnerOf, hostId: HostId): Effect.Effect<boolean> => {
  const owner = ownerOf(hostId);
  if (owner === undefined) return Effect.succeed(true);
  return Effect.map(currentCaller, (caller) => isServerWork(caller) || admitsCall(owner, caller));
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

/** Whose a thread is: its machine's (`HostOwner`), `undefined` on a machine that is anyone's. */
export const threadOwner = (
  ownerOf: OwnerOf,
  thread: Pick<Thread, "checkout" | "currentCheckout">,
): HostOwner => ownerOf(hostOf(effectiveCheckout(thread)));

/** The caller an agent's call on a machine of `owner`'s is made as (`asThreadOwner`). */
export const callerOf = (owner: HostOwner): Caller =>
  typeof owner === "string"
    ? { person: owner }
    : owner !== undefined && "shared" in owner
      ? { person: undefined, scope: owner.shared.scope }
      : { person: undefined };

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
    if (isServerWork(yield* currentCaller)) return true;
    const thread = yield* getThread(threadId).pipe(Effect.orElseSucceed(() => undefined));
    if (thread === undefined) return true;
    // Started for someone before its machine was there: theirs alone until it is on one.
    const startedBy = thread.awaitingMachine?.startedBy;
    if (startedBy !== undefined && (yield* currentCaller)?.person !== startedBy) return false;
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
 * tool call, and kept work done for a thread. Its person for a person's machine, its scope for a
 * shared one. Never from what an agent says, and never the server's own work: no one's for a
 * thread on any other machine, or not stored.
 */
export const asThreadOwner =
  (
    getThread: (threadId: ThreadId) => Effect.Effect<Thread, unknown>,
    ownerOf: OwnerOf,
    threadId: ThreadId,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(getThread(threadId).pipe(Effect.orElseSucceed(() => undefined)), (thread) =>
      Effect.provideService(
        effect,
        RoutedFor,
        thread === undefined ? { person: undefined } : callerOf(threadOwner(ownerOf, thread)),
      ),
    );

/**
 * Whether two places are of one owner: one machine; machines of the same person's or of the same
 * shared scope; or both anyone's. Never two machines that name no one (`NOBODY`), which are no
 * one's together. The one test for a link between threads (a worker under its orchestrator, a
 * join, a move), so an orchestration never spans two people and a thread never changes owner.
 */
export const sameOwner = (
  ownerOf: OwnerOf,
  a: { readonly hostId?: HostId | undefined },
  b: { readonly hostId?: HostId | undefined },
): boolean => {
  if (hostOf(a) === hostOf(b)) return true;
  const x = ownerOf(hostOf(a));
  const y = ownerOf(hostOf(b));
  if (x === undefined || y === undefined) return x === y;
  if (typeof x === "string" || typeof y === "string") return x === y;
  if ("shared" in x && "shared" in y) return x.shared.scope === y.shared.scope;
  return false;
};

/**
 * Whether a thread waiting for its machine (`Thread.awaitingMachine`) may be placed on `hostId`:
 * a machine that admits whoever the thread was started by (`admitsCall`). It has no machine yet,
 * so there is no owner to keep; a thread started by no one in particular goes on any.
 */
export const mayPlaceAwaited = (
  ownerOf: OwnerOf,
  thread: Pick<Thread, "awaitingMachine">,
  hostId: HostId,
): boolean => {
  const startedBy = thread.awaitingMachine?.startedBy;
  return startedBy === undefined || admitsCall(ownerOf(hostId), { person: startedBy });
};

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
 * with no signed-in person, which reaches only machines that are anyone's. Absent: the server's
 * own work.
 */
export interface RecordedActor {
  readonly person?: string;
  /** An agent's shared scope (`Caller.scope`). */
  readonly scope?: string;
}

/** Who work written now is for (`RecordedActor`): this fiber's caller, absent for the server. */
export const recordActor: Effect.Effect<RecordedActor | undefined> = Effect.map(
  currentCaller,
  (caller) =>
    isServerWork(caller)
      ? undefined
      : {
          ...(caller?.person === undefined ? {} : { person: caller.person }),
          ...(caller?.scope === undefined ? {} : { scope: caller.scope }),
        },
);

/**
 * `effect` as the call kept work was written in (`recordActor`), whichever fiber attempts it: a
 * person's work as theirs, the server's as the server's, never as whoever's call a retry is in.
 */
export const asRecorded =
  (actor: RecordedActor | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.provideService(
        RoutedFor,
        actor === undefined
          ? SERVER_WORK
          : { person: actor.person, ...(actor.scope === undefined ? {} : { scope: actor.scope }) },
      ),
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
