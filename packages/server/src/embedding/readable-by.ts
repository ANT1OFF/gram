// Threads readable by one person only (`Thread.readableBy`), for an embedding host.
//
// A host that starts a thread from a profile may name the one subject who may see it
// (`ProfileStartRequest.readableBy`, a subject as fronted sign-in names people). The thread keeps
// it for good: no write changes or clears it (`ThreadStore`), and every thread it spawns, forks or
// makes from one of its agent's tool calls gets the same (`ThreadRuntimes.create`). A thread linked
// to another (a worker under an orchestrator, a join, an adoption) must have the same, so an
// orchestration is all one person's or none of it is.
//
// Who reads is the fiber's reader (`currentReader`): every RPC as its signed-in person, or as no
// one without fronted sign-in (`rpc/actor-guard.ts`); every agent tool call as its own thread's
// `readableBy`, or no one for a thread without it (`app-tools/registry.ts`); the server's own work
// as the server, which reads everything. A fiber that says nothing is no one, as with machines
// (`host/ownership.ts`). One rule, `mayRead`, decides; a reader with no subject never reads such a
// thread, so the rule fails closed.
//
// Whose a thread is gets asked on paths with no store at hand (an event on its way to a window), so
// the store notes each thread's `readableBy` wherever it reads or writes one, and once when it
// opens (`notePrivacy`). The value never changes, so the note never goes stale.

import type { Thread, ThreadId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { currentCaller } from "../host/ownership.ts";

/** Who reads: a person's subject, or none (no signed-in person, or a thread without one). */
export interface Reader {
  readonly subject: string | undefined;
  /**
   * The reader is a thread's agent (a tool call): a thread made in its call is made for the same
   * person, as that thread is (`spawnScope`).
   */
  readonly fromThread?: boolean | undefined;
}

/**
 * Who this fiber reads as, where a route said: set around every RPC and every agent tool call.
 * Absent: read from the caller the fiber is routed for (`currentCaller`).
 */
export const ReadingAs = Context.Reference<Reader | undefined>("@gram/server/ReadingAs", {
  defaultValue: () => undefined,
});

/** What a reader who may not see a thread is told: as if there were none. */
export const NOT_READABLE = "That thread isn't there.";

/** The longest subject a thread is kept for, as `startedBy`: printable, at most 128 characters. */
export const SUBJECT = /^[\x21-\x7e]{1,128}$/;

const known = new Map<ThreadId, string>();

/** Notes whose a thread is, as it is read or written. A value once noted is never changed. */
export const notePrivacy = (thread: Pick<Thread, "id" | "readableBy">): void => {
  if (thread.readableBy !== undefined && !known.has(thread.id))
    known.set(thread.id, thread.readableBy);
};

/** Whether any thread here is readable by one person: none, and nothing need be asked. */
export const anyPrivate = (): boolean => known.size > 0;

/** The subject a thread is readable by, as noted; undefined for a thread readable by anyone. */
export const readableByOf = (threadId: ThreadId): string | undefined => known.get(threadId);

/** This fiber's reader: `ReadingAs`, else its caller's person; undefined for the server's work. */
export const currentReader: Effect.Effect<Reader | undefined> = Effect.gen(function* () {
  const said = yield* ReadingAs;
  if (said !== undefined) return said;
  const caller = yield* currentCaller;
  return caller === undefined ? undefined : { subject: caller.person };
});

/** The rule, given the reader: anyone for a thread without `readableBy`, else that subject alone. */
export const readerMay = (reader: Reader | undefined, readableBy: string | undefined): boolean =>
  readableBy === undefined ||
  reader === undefined ||
  (reader.subject !== undefined && reader.subject === readableBy);

/** Whether this fiber's reader may see a thread whose `readableBy` is this. */
export const mayRead = (readableBy: string | undefined): Effect.Effect<boolean> =>
  Effect.map(currentReader, (reader) => readerMay(reader, readableBy));

/** Whether this fiber's reader may see the thread `threadId`, as noted (`readableByOf`). */
export const mayReadThread = (threadId: ThreadId): Effect.Effect<boolean> =>
  mayRead(readableByOf(threadId));

/** The threads this fiber's reader may not see, as noted: for a query to leave out. */
export const hiddenThreads: Effect.Effect<ReadonlyArray<ThreadId>> = Effect.map(
  currentReader,
  (reader) => [...known].flatMap(([id, by]) => (readerMay(reader, by) ? [] : [id])),
);

/** `items` this fiber's reader may see, by the thread each is of; none of a thread it may not. */
export const readableOnly = <A>(
  items: ReadonlyArray<A>,
  threadOf: (item: A) => ThreadId | Pick<Thread, "id" | "readableBy"> | undefined,
): Effect.Effect<ReadonlyArray<A>> =>
  Effect.map(currentReader, (reader) =>
    items.filter((item) => {
      const of = threadOf(item);
      if (of === undefined) return true;
      const readableBy =
        typeof of === "string" ? readableByOf(of) : (of.readableBy ?? readableByOf(of.id));
      return readerMay(reader, readableBy);
    }),
  );

/**
 * The `readableBy` a thread made in this fiber inherits from the agent whose tool call makes it
 * (`Reader.fromThread`): a private thread's agent makes only threads private to the same person.
 */
export const spawnScope: Effect.Effect<string | undefined> = Effect.map(ReadingAs, (reader) =>
  reader?.fromThread === true ? reader.subject : undefined,
);

/** A key that names a thread of this server's, never another service's (a review's on GitHub). */
const THREAD_KEY = /^(threadId|[a-z]+ThreadId)$/;
const NOT_THREAD_KEYS: ReadonlySet<string> = new Set(["reviewThreadId"]);

/**
 * Every thread a call's payload names anywhere in it, a few levels down too (`answers[].threadId`):
 * what a call reads or acts on, for the readers' rule (`embedding/readable-by.ts`), which must miss
 * none: an RPC's payload (`rpc/actor-guard.ts`) and an agent tool's input (`app-tools/registry.ts`).
 */
export const threadsMentioned = (payload: unknown): ReadonlyArray<ThreadId> => {
  const found: Array<ThreadId> = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 4 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 500)) walk(item, depth + 1);
      return;
    }
    for (const [key, field] of Object.entries(value)) {
      if (typeof field === "string" && THREAD_KEY.test(key) && !NOT_THREAD_KEYS.has(key)) {
        found.push(field as ThreadId);
      } else if (key === "threadIds" && Array.isArray(field)) {
        for (const id of field) if (typeof id === "string") found.push(id as ThreadId);
      } else {
        walk(field, depth + 1);
      }
    }
  };
  walk(payload, 0);
  return found;
};

/** What a link between threads of two different `readableBy`s (or one's and none) is told. */
export const READERS_DIFFER = "Threads that work together are readable by the same person.";

/** Whether two threads may be linked (a worker and its orchestrator, a join, an adoption). */
export const sameReaders = (
  a: Pick<Thread, "id" | "readableBy">,
  b: Pick<Thread, "id" | "readableBy">,
): boolean => (a.readableBy ?? readableByOf(a.id)) === (b.readableBy ?? readableByOf(b.id));
