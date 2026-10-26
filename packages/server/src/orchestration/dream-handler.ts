import {
  answerKeyTag,
  answerMessage,
  answerQuestion,
  DreamRpcs,
  findQuestion,
  InvalidState,
  keptAnswer,
  markAnswerPending,
  type AgentUnavailable,
  type ThreadNotFound,
  QUESTIONS_FILE,
  questionDate,
  type AnswerQuestionResult,
  type QuestionEdit,
  type UserInput,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { randomUUID } from "node:crypto";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { logDefects, type Handlers } from "../rpc/handlers/common.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Dreams } from "./dreams.ts";
import { OrchestrationMemory, type MemoryError, type OrchestrationMemoryShape } from "./memory.ts";
import { makeKeyedLock } from "../git/keyed-lock.ts";

/** How an answer reaches the orchestrator, apart from the file, so a failure can be tried in a test. */
export interface AnswerDelivery<E> {
  /** Steers or sends the message. It may fail after the runtime has recorded or queued it. */
  readonly deliver: (text: string) => Effect.Effect<AnswerQuestionResult["delivered"], E>;
  /** Whether the orchestrator holds a message carrying `tag`: queued, or anywhere in its transcript. */
  readonly holds: (tag: string) => Effect.Effect<boolean>;
}

export type AnswerOnce = <E>(
  memory: OrchestrationMemoryShape,
  workspaceId: WorkspaceId,
  input: {
    readonly questionId?: string | undefined;
    readonly question: string;
    readonly answer: string;
  },
  date: string,
  delivery: AnswerDelivery<E>,
) => Effect.Effect<AnswerQuestionResult, E | MemoryError>;

/**
 * The user's answer, delivered once and then closing its entry.
 *
 * The file carries the answer's identity before the answer goes. The still-open entry records the
 * answer and a `Delivery: pending <key>` line, and the message carries the same key. Then the
 * message goes, and only then does the entry close. Whether the orchestrator holds the answer is a
 * search of its whole transcript and queue for that key, which no time passing and no other write
 * can change. It is asked of a pending entry before anything is sent, and after a failed send,
 * because the runtime records or queues an input before the session call that can fail. So:
 * - a send that never got through leaves the entry open with its key, and the retry sends it;
 * - one that got through, or whose close failed, is found by its key and closed, never sent again.
 * A close written first can't be taken back reliably instead: the write is scrubbed, so the file
 * never reads back as written, and another write may land in between. Answers to one question are
 * taken one at a time in a workspace, so two at once can't both go out, whether they name the
 * question by id or by words: the second finds the first's result. One lock for the workspace rather
 * than one per question, since an entry without an id is given one by the first answer's write.
 */
export const makeAnswerOnce = (): AnswerOnce => {
  const locks = makeKeyedLock<WorkspaceId>();
  return (memory, workspaceId, input, date, delivery) => {
    const name = input.questionId ?? "That question";
    const read = memory
      .read(workspaceId, QUESTIONS_FILE)
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    const edit = (change: (current: string | undefined) => QuestionEdit) =>
      memory.modify(workspaceId, QUESTIONS_FILE, (current) => {
        const made = change(current);
        return made.ok
          ? Effect.succeed({ content: made.content, result: made.id })
          : Effect.fail(new InvalidState({ message: made.problem }));
      });
    /** Closes the entry by its id; one the orchestrator closed meanwhile is left as it is. */
    const close = (id: string, answer: string) =>
      edit((current) =>
        answerQuestion(current, { questionId: id, question: input.question, answer }, date),
      ).pipe(Effect.catchTag("InvalidState", () => Effect.void));

    const run = Effect.gen(function* () {
      const entry = findQuestion(yield* read, input);
      if (entry === undefined) {
        return yield* new InvalidState({ message: `${name} isn't in ${QUESTIONS_FILE} any more.` });
      }
      if (!entry.open) {
        // Pressed again after this very answer went and closed it: that is done, not a failure.
        if (entry.closedAs === "answered" && entry.answer === keptAnswer(input.answer)) {
          return { questionId: entry.id, delivered: "sent" as const };
        }
        return yield* new InvalidState({ message: `${name} is closed already.` });
      }
      if (entry.pending !== undefined && (yield* delivery.holds(answerKeyTag(entry.pending)))) {
        // An earlier attempt got there and didn't close: close it with what that attempt said.
        yield* close(entry.id, entry.answer ?? input.answer);
        return { questionId: entry.id, delivered: "sent" as const };
      }
      const key = entry.pending ?? randomUUID().slice(0, 13);
      const id = yield* edit((current) =>
        markAnswerPending(current, { ...input, questionId: entry.id, key }),
      ).pipe(Effect.map(({ result }) => result));
      const text = answerMessage({ id, text: input.question }, input.answer, key);
      const delivered = yield* delivery
        .deliver(text)
        .pipe(
          Effect.catch((error) =>
            Effect.flatMap(delivery.holds(answerKeyTag(key)), (holds) =>
              holds ? Effect.succeed("sent" as const) : Effect.fail(error),
            ),
          ),
        );
      yield* close(id, input.answer);
      return { questionId: id, delivered };
    });
    return locks.withLock(workspaceId, run);
  };
};

/** A queued input that is one or more answers from the Answer button, and nothing else. */
export const isQueuedAnswer = (input: UserInput): boolean =>
  input.origin === undefined &&
  input.notice === undefined &&
  (input.attachments?.length ?? 0) === 0 &&
  /\(answer key [^)]+\)$/.test(input.text);

/**
 * `dream.*` and `memory.*`: the user's side of dreams and of a workspace's memory.
 * Nothing here is an app tool, which is what keeps adoption, restore and the
 * Memory tab's edits the user's alone. The memory calls work while orchestration is paused, since
 * a pause stops what is sent to the orchestrator, not what the user may fix. `question.answer` is the user's too:
 * the answer is theirs to give, and it closes the entry before the orchestrator reads it.
 */
export const dreamHandlers = Effect.gen(function* () {
  const dreams = yield* Dreams;
  const memory = yield* OrchestrationMemory;
  const store = yield* ThreadStore;
  const hub = yield* EventHub;
  const runtimes = yield* ThreadRuntimes;
  const answerOnce = makeAnswerOnce();

  /** The workspace exists; memory folders are made on demand, so ask first. */
  const guard = (workspaceId: WorkspaceId) => Effect.asVoid(store.getWorkspace(workspaceId));

  const changed = (workspaceId: WorkspaceId) =>
    hub.publish({ type: "orchestration.changed", workspaceId });

  return {
    "dream.automaticStatus": ({ workspaceId }) => dreams.automaticStatus(workspaceId),
    "dream.preview": (input) => dreams.preview(input),
    "dream.start": (input) => dreams.start(input),
    "dream.list": ({ workspaceId }) => dreams.list(workspaceId),
    "dream.review": ({ dreamId }) => dreams.review(dreamId),
    "dream.cancel": ({ dreamId }) => dreams.cancel(dreamId),
    "dream.adopt": ({ dreamId, resolutions, basedOn, outputDigest }) =>
      dreams.adopt(dreamId, { resolutions, basedOn, outputDigest }),
    "dream.merge": ({ dreamId, path }) => dreams.merge(dreamId, path),
    "dream.discard": ({ dreamId }) => dreams.discard(dreamId),

    "memory.list": ({ workspaceId }) =>
      Effect.andThen(guard(workspaceId), memory.list(workspaceId)),
    "memory.read": ({ workspaceId, path }) =>
      guard(workspaceId).pipe(
        Effect.andThen(memory.read(workspaceId, path)),
        Effect.map((content) => ({ path, content })),
      ),
    "memory.write": ({ workspaceId, path, content }) =>
      guard(workspaceId).pipe(
        Effect.andThen(memory.write(workspaceId, path, content)),
        Effect.tap(() => changed(workspaceId)),
      ),
    "memory.delete": ({ workspaceId, path }) =>
      guard(workspaceId).pipe(
        Effect.andThen(memory.remove(workspaceId, path)),
        Effect.tap(() => changed(workspaceId)),
      ),
    "question.answer": ({ workspaceId, questionId, question, answer }) =>
      Effect.gen(function* () {
        yield* guard(workspaceId);
        const orchestrator = (yield* store.getWorkspace(workspaceId)).workspace
          .orchestratorThreadId;
        const summary =
          orchestrator === undefined ? undefined : yield* runtimes.summaryOf(orchestrator);
        if (orchestrator === undefined || summary === undefined) {
          return yield* new InvalidState({
            message: "This workspace has no orchestrator open to take the answer.",
          });
        }
        const delivery: AnswerDelivery<ThreadNotFound | InvalidState | AgentUnavailable> = {
          // Never steered: a steer interrupts the turn, and answers given in a burst cut off one
          // turn after another (36 of 68 interrupted turns in the 0.8 retro). One queued behind a
          // running turn joins an earlier answer still waiting, so a burst lands as one turn.
          deliver: (text) =>
            runtimes
              .sendOrJoin(
                orchestrator,
                { text },
                ({ input }, next) => ({ ...input, text: `${input.text}\n\n${next.text}` }),
                isQueuedAnswer,
              )
              .pipe(Effect.map(({ queued }) => (queued ? ("queued" as const) : ("sent" as const)))),
          holds: (tag) =>
            Effect.gen(function* () {
              const queued = (yield* runtimes.summaryOf(orchestrator))?.queue.some((item) =>
                item.input.text.includes(tag),
              );
              if (queued === true) return true;
              return (yield* store.listMessages(orchestrator)).some(
                (message) =>
                  message.role === "user" &&
                  message.parts.some((part) => part.type === "text" && part.text.includes(tag)),
              );
            }),
        };
        const result = yield* answerOnce(
          memory,
          workspaceId,
          { questionId, question, answer },
          questionDate(yield* Clock.currentTimeMillis),
          delivery,
        );
        yield* changed(workspaceId);
        return result;
      }),
    "memory.versions": ({ workspaceId }) =>
      Effect.andThen(guard(workspaceId), memory.versions(workspaceId)),
    "memory.restore": ({ workspaceId, version }) =>
      guard(workspaceId).pipe(
        Effect.andThen(memory.restore(workspaceId, version)),
        Effect.tap(() => changed(workspaceId)),
      ),
  } satisfies Partial<Handlers>;
});

/** The dreams group's handler layer: dreams, a workspace's memory and its questions. */
export const DreamHandlersLive = DreamRpcs.toLayer(
  Effect.map(dreamHandlers, (handlers) => DreamRpcs.of(logDefects(DreamRpcs, handlers))),
);
