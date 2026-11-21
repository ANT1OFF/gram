import {
  QUESTIONS_FILE,
  readQuestionsEdit,
  renderStoredQuestions,
  storedQuestionList,
  storedQuestionsOf,
  type MemoryQuestion,
  type MemoryWrite,
  type ServerEvent,
  type StoredMemoryQuestions,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeKeyedLock } from "../../git/keyed-lock.ts";
import { redactText } from "../../logging/redact.ts";
import { memoryRevision, type MemoryError } from "../memory.ts";
import { type OrchestrationKit } from "./kit.ts";

/**
 * An orchestrator's questions in the server's store, beside its workers' (the outbox's
 * `memoryQuestions`), with `questions.md` in its memory written from them. Every change goes
 * through the store, and an edit someone made to the file is read as asks and closes first
 * (`readQuestionsEdit`), so the dream run, a person and the memory tools keep editing the file.
 */
export interface MemoryQuestionsShape {
  /** The file as the store writes it, with any edit to it read in first; `undefined` with none. */
  read(workspaceId: WorkspaceId): Effect.Effect<string | undefined, MemoryError>;
  /** The questions, open and closed, as `read`. */
  list(workspaceId: WorkspaceId): Effect.Effect<readonly MemoryQuestion[], MemoryError>;
  /**
   * `memory.modify` of `questions.md` through the store: `change` is given the file as the store
   * has it, and what it returns becomes the store and the file. One at a time in a workspace.
   */
  modify<A, E>(
    workspaceId: WorkspaceId,
    change: (current: string) => Effect.Effect<{ readonly content: string; readonly result: A }, E>,
  ): Effect.Effect<
    {
      readonly write: MemoryWrite;
      readonly result: A;
      readonly revision: string;
    },
    MemoryError | E
  >;
  /**
   * Reads an edit made to the file since the store last wrote it, and writes the file back from
   * the store. Whether the file changed; a file the store already wrote is left alone.
   */
  settle(workspaceId: WorkspaceId): Effect.Effect<boolean, MemoryError>;
}

const viewOf = (content: string | undefined): string =>
  content === undefined ? "" : memoryRevision(content);

const fileOf = (stored: StoredMemoryQuestions | undefined, current: string | undefined): string => {
  if (stored === undefined) return current ?? "";
  if (stored.view === viewOf(current)) return renderStoredQuestions(stored);
  return readQuestionsEdit(stored, current).content;
};

export const makeMemoryQuestions = (
  kit: Pick<OrchestrationKit, "memory" | "readOutbox" | "updateOutbox" | "hub">,
) =>
  Effect.gen(function* () {
    const { memory, readOutbox, updateOutbox, hub } = kit;
    const locks = makeKeyedLock<WorkspaceId>();
    const stored = (workspaceId: WorkspaceId) =>
      Effect.map(readOutbox(workspaceId), (outbox) => outbox.memoryQuestions);
    const readFile = (workspaceId: WorkspaceId) =>
      memory
        .read(workspaceId, QUESTIONS_FILE)
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    const save = (workspaceId: WorkspaceId, memoryQuestions: StoredMemoryQuestions) =>
      updateOutbox(workspaceId, (outbox) => [{ ...outbox, memoryQuestions }, undefined] as const);

    const modifyLocked = <A, E>(
      workspaceId: WorkspaceId,
      change: (
        current: string,
      ) => Effect.Effect<{ readonly content: string; readonly result: A }, E>,
    ) =>
      Effect.gen(function* () {
        let written = "";
        const done = yield* memory.modify(workspaceId, QUESTIONS_FILE, (current) =>
          Effect.gen(function* () {
            const made = yield* change(fileOf(yield* stored(workspaceId), current));
            written = renderStoredQuestions(storedQuestionsOf(redactText(made.content), ""));
            const changed = written !== current;
            return { content: written, result: { result: made.result, changed } };
          }),
        );
        yield* save(workspaceId, storedQuestionsOf(written, done.revision));
        return { write: done.write, result: done.result, revision: done.revision };
      });

    const settleLocked = (workspaceId: WorkspaceId) =>
      Effect.gen(function* () {
        const before = yield* stored(workspaceId);
        const current = yield* readFile(workspaceId);
        if (before !== undefined && before.view === viewOf(current)) return false;
        const anyOpen = before?.entries.some((entry) => entry.question.open) ?? false;
        if (current === undefined && !anyOpen) {
          if (before !== undefined) yield* save(workspaceId, storedQuestionsOf(undefined, ""));
          return false;
        }
        const { result } = yield* modifyLocked(workspaceId, (content) =>
          Effect.succeed({ content, result: undefined }),
        );
        if (result.changed) yield* hub.publish({ type: "memory.changed", workspaceId });
        return result.changed;
      });

    const settled = <A>(workspaceId: WorkspaceId, then: (after?: StoredMemoryQuestions) => A) =>
      locks.withLock(
        workspaceId,
        Effect.gen(function* () {
          yield* settleLocked(workspaceId);
          return then(yield* stored(workspaceId));
        }),
      );

    const shape: MemoryQuestionsShape = {
      read: (workspaceId) =>
        settled(workspaceId, (after) =>
          after === undefined || after.view === "" ? undefined : renderStoredQuestions(after),
        ),
      list: (workspaceId) =>
        settled(workspaceId, (after) => (after === undefined ? [] : storedQuestionList(after))),
      modify: (workspaceId, change) =>
        locks.withLock(
          workspaceId,
          Effect.map(modifyLocked(workspaceId, change), (done) => ({
            ...done,
            result: done.result.result,
          })),
        ),
      settle: (workspaceId) => locks.withLock(workspaceId, settleLocked(workspaceId)),
    };

    yield* hub
      .internalEvents(
        (event): event is ServerEvent & { readonly type: "dreams.changed" } =>
          event.type === "dreams.changed",
        "questions.md after a dream",
      )
      .pipe(
        Stream.runForEach((event) =>
          shape
            .settle(event.workspaceId)
            .pipe(Effect.catch((error) => Effect.logWarning("questions.md not read back", error))),
        ),
        Effect.forkScoped,
      );
    return shape;
  });
