import { InvalidState, THREAD_READERS_MAX, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { privacyFamily, SUBJECT } from "./readable-by.ts";

/** What a set of readers that isn't one is told. */
export const NOT_READERS = `Name each reader by their subject (printable, at most 128 characters), at most ${THREAD_READERS_MAX} of them.`;

/** What readers for a thread everyone may read are told. */
export const READERS_NEED_A_PERSON =
  "Only a thread readable by one person has readers beside them.";

/** What readers for a thread that isn't there are told. */
export const NO_SUCH_THREAD = "That thread isn't there.";

/** What is wrong with `readers` for a thread readable by `readableBy`, if anything. */
export const readersProblem = (
  readableBy: string | undefined,
  readers: ReadonlyArray<string> | undefined,
): string | undefined => {
  if (readers === undefined || readers.length === 0) return undefined;
  if (readableBy === undefined) return READERS_NEED_A_PERSON;
  if (readers.length > THREAD_READERS_MAX || readers.some((each) => !SUBJECT.test(each)))
    return NOT_READERS;
  return undefined;
};

/** `readers` as kept: checked, without duplicates or the thread's own person, sorted. */
export const readersFor = (
  readableBy: string | undefined,
  readers: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<string>, InvalidState> => {
  const problem = readersProblem(readableBy, readers);
  if (problem !== undefined) return Effect.fail(new InvalidState({ message: problem }));
  return Effect.succeed(
    [...new Set(readers ?? [])].filter((each) => each !== readableBy).toSorted(),
  );
};

/** The readers set on `threadId` and the threads that share its privacy; the ids changed. */
export const setReaders = (
  store: Pick<ThreadStoreShape, "getThread" | "listThreads" | "listClosed" | "setThreadReaders">,
  threadId: ThreadId,
  readers: ReadonlyArray<string>,
): Effect.Effect<
  { readonly readers: ReadonlyArray<string>; readonly threadIds: ReadonlyArray<ThreadId> },
  InvalidState
> =>
  Effect.gen(function* () {
    const open = yield* store.getThread(threadId).pipe(Effect.option);
    const closed = Option.isSome(open)
      ? []
      : (yield* store.listClosed).map((entry) => entry.thread);
    const root = Option.isSome(open) ? open.value : closed.find((each) => each.id === threadId);
    if (root === undefined) return yield* new InvalidState({ message: NO_SUCH_THREAD });
    if (root.readableBy === undefined)
      return yield* new InvalidState({ message: READERS_NEED_A_PERSON });
    const kept = yield* readersFor(root.readableBy, readers);
    const all = [
      ...(yield* store.listThreads),
      ...(Option.isSome(open) ? (yield* store.listClosed).map((entry) => entry.thread) : closed),
    ];
    const threadIds = yield* store.setThreadReaders(privacyFamily(root, all), kept);
    return { readers: kept, threadIds };
  });
