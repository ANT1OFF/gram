import {
  effectiveCheckout,
  hostOf,
  type HostId,
  HostUnavailable,
  InvalidState,
  type RequestAnswer,
  type Thread,
  type ThreadId,
  sessionHostOf,
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
 * work, as who it was written for. Absent for the server's own work, which holds `ServerWork`,
 * and for a fiber that says nothing, which is no one's.
 */
export interface Caller {
  readonly person: string | undefined;
}

export const RoutedFor = Context.Reference<Caller | undefined>("@gram/server/RoutedFor", {
  defaultValue: () => undefined,
});

/**
 * The capability the server's own work runs with: granted where the server starts (`main.ts`),
 * and to kept work the server wrote (`asRecorded`). Without it, and with no caller said, a fiber
 * is no one's: it reaches only machines open to every caller, never one started for someone.
 */
export const ServerWork = Context.Reference<boolean>("@gram/server/ServerWork", {
  defaultValue: () => false,
});

/** `effect` as the server's own work (`ServerWork`), whoever's fiber runs it. */
export const asServer = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.provideService(RoutedFor, undefined),
    Effect.provideService(ActingPerson, undefined),
    Effect.provideService(ServerWork, true),
  );

const NO_ONE: Caller = { person: undefined };

/**
 * This fiber's caller: `RoutedFor`, else the acting person where one is known, else the server's
 * own work (`undefined`) where it holds `ServerWork`, else no one.
 */
export const currentCaller: Effect.Effect<Caller | undefined> = Effect.gen(function* () {
  const routed = yield* RoutedFor;
  if (routed !== undefined) return routed;
  const person = yield* ActingPerson;
  if (person !== undefined) return { person };
  return (yield* ServerWork) ? undefined : NO_ONE;
});

/** The person what is placed now is for, where one is known. */
export const callerPerson: Effect.Effect<string | undefined> = Effect.map(
  currentCaller,
  (caller) => caller?.person,
);

/**
 * Whose a machine is (`holderOf`), when it is anyone's; with `personOf` where the machines say
 * who besides may reach one (`PairedMachine.person`). Made without it, no one besides does.
 */
export type OwnerOf = ((hostId: HostId) => string | undefined) & {
  readonly personOf?: (hostId: HostId) => string | undefined;
  /**
   * Whether any signed-in member may answer the requests a machine's threads wait on
   * (`PairedMachine.answeredBy`). Made without it, no one besides its owner and person may.
   */
  readonly answeredByMembers?: (hostId: HostId) => boolean;
};

const CLOSED = "\u0000closed:";

/**
 * Whose a machine is, as the rule compares it: its owner where it names one; for one started on
 * demand that names none (registered before owners were required), a holder of its own that no
 * caller is and no other machine shares, so only the server's own work reaches it and nothing
 * links to it; for a machine of no kind, none, so it is open to every caller.
 */
export const holderOf = (machine: {
  readonly id: string;
  readonly owner?: string | undefined;
  readonly onDemand?: string | undefined;
  /** A worker host a desktop asked a hosted server for: the desktop's, open as a joined one is. */
  readonly via?: string | undefined;
}): string | undefined =>
  machine.owner ??
  (machine.onDemand === undefined || machine.via !== undefined
    ? undefined
    : `${CLOSED}${machine.id}`);

/** Whether a holder (`holderOf`) is a closed machine's, which no person or embedder names. */
export const isClosed = (holder: string | undefined): boolean =>
  holder !== undefined && holder.startsWith(CLOSED);

/** A holder as a subject to tell an embedder (an owner), never a closed machine's. */
export const ownerSubject = (holder: string | undefined): string | undefined =>
  isClosed(holder) ? undefined : holder;

/** Owners as the joined machines record them, as the rule compares them (`holderOf`). */
export const ownersOf = (
  machines:
    | {
        readonly list: () => ReadonlyArray<{
          readonly id: string;
          readonly owner?: string | undefined;
          readonly person?: string | undefined;
          readonly answeredBy?: "members" | undefined;
          readonly onDemand?: string | undefined;
          readonly via?: string | undefined;
        }>;
      }
    | undefined,
): OwnerOf =>
  Object.assign(
    (hostId: HostId) => {
      const machine = machines?.list().find((each) => each.id === hostId);
      return machine === undefined ? undefined : holderOf(machine);
    },
    {
      personOf: (hostId: HostId) => {
        const machine = machines?.list().find((each) => each.id === hostId);
        return machine?.owner === undefined ? undefined : machine.person;
      },
      answeredByMembers: (hostId: HostId) => {
        const machine = machines?.list().find((each) => each.id === hostId);
        return machine?.owner !== undefined && machine.answeredBy === "members";
      },
    },
  );

/**
 * The rule. Whether this fiber's caller may reach `hostId`: a machine open to every caller (no
 * kind, no owner), the server's own work (`ServerWork`), or its owner's call. Anyone else's, a
 * call with no signed-in person, and a fiber that says nothing may not; nor may anyone but the
 * server reach a closed machine (`holderOf`).
 */
export const mayReach = (ownerOf: OwnerOf, hostId: HostId): Effect.Effect<boolean> => {
  const owner = ownerOf(hostId);
  if (owner === undefined) return Effect.succeed(true);
  const person = ownerOf.personOf?.(hostId);
  return Effect.map(
    currentCaller,
    (caller) =>
      caller === undefined ||
      (caller.person !== undefined && (caller.person === owner || caller.person === person)),
  );
};

/**
 * `reach` (a machine's host by id), refused for a machine this fiber's caller may not reach: the
 * door every route to a joined machine goes through (`WorkerHosts.get`, the session lookup).
 */
export const ownedMachines =
  <H, A extends ReadonlyArray<unknown> = []>(
    ownerOf: OwnerOf,
    reach: (id: HostId, ...rest: A) => Effect.Effect<H, HostUnavailable>,
  ) =>
  (id: HostId, ...rest: A): Effect.Effect<H, HostUnavailable> =>
    Effect.flatMap(mayReach(ownerOf, id), (ok) =>
      ok
        ? reach(id, ...rest)
        : Effect.fail(new HostUnavailable({ hostId: id, message: NOT_YOUR_MACHINE })),
    );

const checkoutsOf = (thread: Pick<Thread, "checkout" | "currentCheckout" | "extraCheckouts">) => [
  thread.checkout,
  ...(thread.currentCheckout === undefined ? [] : [thread.currentCheckout]),
  ...(thread.extraCheckouts ?? []),
];

/** Whose a thread is: its machine's owner, where it is on a machine started for someone. */
export const threadOwner = (
  ownerOf: OwnerOf,
  thread: Pick<Thread, "checkout" | "currentCheckout" | "dreamHost">,
) => ownerOf(sessionHostOf(thread));

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
    if ((yield* currentCaller) === undefined) return true;
    const thread = yield* getThread(threadId).pipe(Effect.orElseSucceed(() => undefined));
    if (thread === undefined) return true;
    return yield* mayReachMachinesOf(ownerOf, thread);
  });

/**
 * Whether this fiber's caller may reach every machine `thread` works or worked on: a stored
 * thread's, or a closed one's as kept (`ThreadStore.closedHolderOf`).
 */
export const mayReachMachinesOf = (
  ownerOf: OwnerOf,
  thread: Pick<
    Thread,
    "checkout" | "currentCheckout" | "extraCheckouts" | "dreamHost" | "awaitingMachine"
  >,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if ((yield* currentCaller) === undefined) return true;
    const startedBy = thread.awaitingMachine?.startedBy;
    if (startedBy !== undefined && (yield* currentCaller)?.person !== startedBy) return false;
    for (const checkout of checkoutsOf(thread))
      if (!(yield* mayReach(ownerOf, hostOf(checkout)))) return false;
    if (thread.dreamHost !== undefined && !(yield* mayReach(ownerOf, thread.dreamHost)))
      return false;
    return true;
  });

/**
 * How this fiber's caller may answer a request `threadId` waits on: as one who may reach it
 * (`owner`, `mayReachThread`); as a member (`member`), a person signed in (`ActingPerson`, never an
 * agent's call made as its machine's owner) on a thread whose every machine lets members answer
 * (`OwnerOf.answeredByMembers`), whose answer is held to `asAMembersAnswer`; or not at all.
 */
export const answerAdmission = (
  getThread: (threadId: ThreadId) => Effect.Effect<Thread, unknown>,
  ownerOf: OwnerOf,
  threadId: ThreadId,
): Effect.Effect<"owner" | "member" | undefined> =>
  Effect.gen(function* () {
    if (yield* mayReachThread(getThread, ownerOf, threadId)) return "owner";
    const answeredByMembers = ownerOf.answeredByMembers;
    if (answeredByMembers === undefined || (yield* ActingPerson) === undefined) return undefined;
    const thread = yield* getThread(threadId).pipe(Effect.orElseSucceed(() => undefined));
    if (thread === undefined || thread.awaitingMachine !== undefined) return undefined;
    const hosts = [
      ...checkoutsOf(thread).map((checkout) => hostOf(checkout)),
      ...(thread.dreamHost === undefined ? [] : [thread.dreamHost]),
    ];
    return hosts.every((hostId) => ownerOf(hostId) === undefined || answeredByMembers(hostId))
      ? "member"
      : undefined;
  });

/**
 * A member's answer as it is taken (`answerAdmission`): this one request alone. An approval holds
 * for this call only (`scope: "once"`, never a rule kept for the session or after), and a plan's
 * approval switches no mode, since a member may not set the thread's mode.
 */
export const asAMembersAnswer = (answer: RequestAnswer): RequestAnswer => {
  if (answer.kind === "approval") return { ...answer, scope: "once" };
  if (answer.kind === "plan") {
    const { mode: _notTheirs, ...rest } = answer;
    return rest;
  }
  return answer;
};

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
 * Whether two places are of one owner: machines of the same owner's, or both open to every
 * caller. A closed machine (`holderOf`) is of one owner with itself alone. The
 * one test for a link between threads (a worker under its orchestrator, a join, a move), so an
 * orchestration never spans two people and a thread never changes owner.
 */
export const sameOwner = (
  ownerOf: OwnerOf,
  a: { readonly hostId?: HostId | undefined },
  b: { readonly hostId?: HostId | undefined },
): boolean => ownerOf(hostOf(a)) === ownerOf(hostOf(b));

/**
 * Whether a thread waiting for its machine (`Thread.awaitingMachine`) may be placed on `hostId`:
 * a machine started for whoever the thread was started by, or reached by them beside its owner
 * (`PairedMachine.person`), or for nobody. It has no machine yet,
 * so there is no owner to keep; a thread started by no one in particular goes on any.
 */
export const mayPlaceAwaited = (
  ownerOf: OwnerOf,
  thread: Pick<Thread, "awaitingMachine">,
  hostId: HostId,
): boolean => {
  const owner = ownerOf(hostId);
  const startedBy = thread.awaitingMachine?.startedBy;
  return (
    owner === undefined ||
    startedBy === undefined ||
    owner === startedBy ||
    ownerOf.personOf?.(hostId) === startedBy
  );
};

/** What a move that would hand a thread to another owner, or to none, is told. */
export const MOVE_CHANGES_OWNER =
  "A thread moves only onto a machine started for the same person as the one it is on.";

/**
 * Whether a move from `from` to `to` gives a thread on a closed machine (`holderOf`, one started
 * on demand before owners were required) the owner its embedder now names: what the embedder's
 * own move may do, as a thread whose machine is gone is placed on one started for whom it is
 * for. Never the other way, and never from a machine open to every caller, whose threads are
 * anyone's to take.
 */
export const claimsUnowned = (ownerOf: OwnerOf, from: HostId, to: HostId): boolean =>
  isClosed(ownerOf(from)) && ownerSubject(ownerOf(to)) !== undefined;

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
    actor === undefined
      ? asServer(effect)
      : effect.pipe(
          Effect.provideService(RoutedFor, { person: actor.person }),
          Effect.provideService(ActingPerson, actor.person),
          Effect.provideService(ServerWork, false),
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
