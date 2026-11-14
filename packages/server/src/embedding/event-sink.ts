// The event sink: what happens on this server, numbered and sent in order to a configured
// endpoint, at least once, picking up after a restart from where the receiver left off.
//
// Off unless an endpoint is configured (`ServerConfigShape.eventSink`) and hosted features are on
// in the settings; while off nothing is recorded, so nothing is sent later about that time.
//
// Events are written to the outbox (`outbox.ts`) as the hub publishes them, then sent from it in
// batches. The receiver's answer says what it holds, and sending goes on from there, forward or
// back. What the outbox holds is never skipped. What a crash kept from reaching the outbox is
// not: each start, and each time the feature is turned on, opens with `sink.started` and every
// open thread, which a receiver reconciles against.
//
// With messages sent, the ones stored before they were are sent too, once: the backfill, below.

import type { AnswerProof } from "./answer-proof.ts";
import {
  approvalSubject,
  type DecisionAssignee,
  EMBEDDING_WIRE_VERSION,
  embeddingOn,
  type FeatureCard,
  type PendingRequest,
  type RequestId,
  type ServerEvent,
  SinkAck,
  type SinkBatch,
  type SinkEvent,
  type SinkEventType,
  type Thread,
  type ThreadId,
  type WorkerQuestion,
  type WorkspaceId,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ENDPOINT_UNUSABLE, type EndpointConfig, ServerConfig } from "../config.ts";
import { EventHub, isOwnEvent, type OwnEvent } from "../events/event-hub.ts";
import { type StoredMessage, ThreadStore } from "../persistence/thread-store.ts";
import { readOutbox as readStoredOutbox } from "../orchestration/outbox.ts";
import { publicQuestion, questionsOf } from "../orchestration/worker-questions.ts";
import {
  ASK_OPTION_DESCRIPTION_MAX_CHARS,
  ASK_OPTION_LABEL_MAX_CHARS,
  ASK_OPTIONS_MAX,
  ASK_QUESTION_MAX_CHARS,
  ASK_QUESTIONS_MAX,
} from "./ask-limits.ts";
import { postJson } from "./endpoint.ts";
import { messageEvent } from "./message-event.ts";
import {
  isUsersQuestion,
  workerQuestionAsk,
  workerQuestionAskId,
  workerQuestionHow,
} from "./worker-question-asks.ts";
import { openOutbox, type Outbox, type SinkEventInput } from "./outbox.ts";

/** An event as server code records it: the sink adds when, and the outbox its number. */
export type SinkRecord = Omit<SinkEventInput, "at" | "type"> & { readonly type: SinkEventType };

/** What the decision hook said about an approval it sent to a person, for its `ask.opened`. */
export interface AskNote {
  readonly decisionId: string;
  readonly assignees?: ReadonlyArray<DecisionAssignee>;
  readonly title?: string;
}

/** A person's answer to a card, for its `ask.resolved`. */
export interface AnswerNote {
  readonly decision?: "approve" | "reject";
  readonly answeredBy?: string;
  /** The request the answer came in, where it came as one (`ask-answer.ts`). */
  readonly proof?: AnswerProof;
}

/** Answers kept for an `ask.resolved` that never came: the oldest go past this many. */
const ANSWER_NOTES_KEPT = 1000;

export interface EventSinkShape {
  /** Records one event, if the sink is on. Never fails: a sink that can't write logs it. */
  record(event: SinkRecord): Effect.Effect<void>;
  /** Kept for the `ask.opened` of the approval `requestId`, which is published after this. */
  noteAsk(requestId: RequestId, note: AskNote): Effect.Effect<void>;
  /**
   * A person is answering `requestId`: kept for its `ask.resolved`, which is published after
   * this. `undefined` takes it back, for an answer that wasn't taken.
   */
  noteAnswer(requestId: RequestId, note: AnswerNote | undefined): Effect.Effect<void>;
  /**
   * `person` started `threadId`: sent as `createdBy` on its `thread.upsert`s, the first of which
   * is published after this. Kept across restarts.
   */
  noteCreator(threadId: ThreadId, person: string): Effect.Effect<void>;
  /** A workspace's feature cards that changed, as the orchestration reconciled them. */
  featureCards(cards: ReadonlyArray<FeatureCard>): Effect.Effect<void>;
  /**
   * How the sink has a workspace's feature cards reconciled when its ledger moves, since with no
   * window watching nothing else does. Set once, by the orchestration.
   */
  setFeatureCardRefresh(
    refresh: (workspaceId: WorkspaceId) => Effect.Effect<void>,
  ): Effect.Effect<void>;
}

export interface EventSinkOptions {
  readonly endpoint: EndpointConfig;
  /** The outbox's file; `:memory:` for one that goes with the process. */
  readonly file: string;
  /** Whether hosted features are on now; asked again every `recheck`. */
  readonly on: Effect.Effect<boolean>;
  /** Every open thread, for `sink.started`. */
  readonly threads: Effect.Effect<ReadonlyArray<Thread>>;
  /** The ids of the cards open now, for a `sink.started` that isn't the server's start. */
  readonly openAsks?: Effect.Effect<ReadonlyArray<string>>;
  /**
   * A workspace's worker questions, or every workspace's without one, for the asks of those that
   * wait on the user (`worker-question-asks.ts`). Absent, none is sent.
   */
  readonly workerQuestions?: (
    workspaceId?: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<WorkerQuestion>>;
  /** The server's events to record; absent in a test that records by hand. */
  readonly events?: Stream.Stream<ServerEvent | OwnEvent>;
  /**
   * Reads a thread's stored messages (`ThreadStoreShape.storedMessages`), for the `message`
   * events a deployment asked for. Absent, none is sent, whatever `events` carries.
   */
  readonly messages?: (
    threadId: ThreadId,
    select: { readonly messageId: string } | { readonly afterSeq: number; readonly limit: number },
  ) => Effect.Effect<ReadonlyArray<StoredMessage>>;
  readonly batchSize?: number;
  /** With `messages`: the bytes of events one batch carries before it takes no more. */
  readonly batchBytes?: number;
  /** The first wait after a send that failed or was not taken; it doubles up to `retryMax`. */
  readonly retryBase?: Duration.Duration;
  readonly retryMax?: Duration.Duration;
  readonly recheck?: Duration.Duration;
  readonly timeoutMs?: number;
  /** How many recorded events may wait unconfirmed before the oldest are given up. */
  readonly maxUnsent?: number;
  /** How many confirmed events the outbox keeps (`OUTBOX_KEEPS_CONFIRMED`). */
  readonly keepsConfirmed?: number;
  /** With `messages`: the wait between two pages of the backfill. */
  readonly backfillPause?: Duration.Duration;
}

/**
 * How many events wait for a receiver that isn't taking them before the sink gives the backlog
 * up, so an endpoint that is down for days can't fill the disk. Giving up starts a new source,
 * which opens with every thread.
 */
export const SINK_MAX_UNSENT = 200_000;

/**
 * With messages sent, a batch stops taking events once it holds this many bytes of them, so two
 * hundred large messages are not one request. It always carries one event at least.
 */
export const SINK_BATCH_BYTES = 1024 * 1024;

/** How many messages a thread's stored messages are read and recorded at a time. */
const MESSAGES_PAGE = 50;

/**
 * The backfill's pace: one page of a thread's stored messages (`MESSAGES_PAGE` of them, or one
 * batch's bytes if that is fewer) each time this has passed and the receiver holds everything
 * recorded so far.
 */
export const SINK_BACKFILL_PAUSE = Duration.millis(500);

/** How many messages' last-sent content is remembered, to leave an unchanged rewrite unsent. */
const SENT_MESSAGES_KEPT = 5000;

/** A thread as `thread.upsert` and `sink.started` send it. */
export const threadData = (thread: Thread, status?: string): Record<string, unknown> => ({
  id: thread.id,
  title: thread.title,
  role: thread.role === "orchestrator" ? "orchestrator" : thread.spawnedBy ? "worker" : "plain",
  model: thread.model.model,
  agent: thread.model.agent,
  ...(status === undefined ? {} : { status }),
  ...(thread.spawnedBy === undefined ? {} : { spawnedByThreadId: thread.spawnedBy.threadId }),
});

const askTitle = (request: PendingRequest): string => {
  if (request.kind === "approval") {
    return `${request.displayName}: ${approvalSubject(request)}`.slice(0, 300);
  }
  if (request.kind === "question") return request.questions[0]?.question ?? "Question";
  return "Plan";
};

export {
  ASK_OPTION_LABEL_MAX_CHARS,
  ASK_OPTIONS_MAX,
  ASK_QUESTION_MAX_CHARS,
  ASK_QUESTIONS_MAX,
} from "./ask-limits.ts";
/** The most of a plan `ask.opened` carries; a longer plan is cut and marked `planTruncated`. */
export const ASK_PLAN_MAX_CHARS = 50_000;

/**
 * What a receiver needs to show a question or a plan and answer it through `asks/answer`: the
 * questions with their choices, or the plan. An answer is keyed by each question's text and names
 * choices by their labels, so neither is ever cut: a question ask that doesn't fit whole is sent
 * without its questions, and a receiver sends the person to the thread. An approval has neither.
 */
export const askContent = (
  request: PendingRequest,
): {
  readonly questions?: ReadonlyArray<unknown>;
  readonly plan?: string;
  readonly planTruncated?: true;
} => {
  if (request.kind === "plan") {
    return request.plan.length > ASK_PLAN_MAX_CHARS
      ? { plan: request.plan.slice(0, ASK_PLAN_MAX_CHARS), planTruncated: true }
      : { plan: request.plan };
  }
  if (request.kind !== "question") return {};
  const { questions } = request;
  const fits =
    questions.length > 0 &&
    questions.length <= ASK_QUESTIONS_MAX &&
    questions.every(
      (each) =>
        each.question.length > 0 &&
        each.question.length <= ASK_QUESTION_MAX_CHARS &&
        each.options.length <= ASK_OPTIONS_MAX &&
        each.options.every(
          (option) => option.label.length > 0 && option.label.length <= ASK_OPTION_LABEL_MAX_CHARS,
        ),
    );
  if (!fits) return {};
  return {
    questions: questions.map((each) => ({
      question: each.question,
      ...(each.header === "" ? {} : { header: each.header.slice(0, 200) }),
      options: each.options.map((option) => ({
        label: option.label,
        ...(option.description === ""
          ? {}
          : { description: option.description.slice(0, ASK_OPTION_DESCRIPTION_MAX_CHARS) }),
      })),
      multiSelect: each.multiSelect,
    })),
  };
};

/** Statuses in which a thread has no turn running: what `thread.status` calls idle. */
const IDLE_STATUSES: ReadonlySet<string> = new Set(["idle", "cold"]);

const decodeAck = Schema.decodeUnknownOption(SinkAck);

/**
 * The sink over one endpoint and outbox file, sending for as long as the scope is open. Closing
 * the scope stops the sending and closes the file; what wasn't sent stays in it.
 */
export const makeEventSink = (
  options: EventSinkOptions,
): Effect.Effect<EventSinkShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const batchSize = options.batchSize ?? 200;
    const retryBase = options.retryBase ?? Duration.seconds(1);
    const retryMax = options.retryMax ?? Duration.seconds(30);
    const recheck = options.recheck ?? Duration.seconds(2);
    const cardsSettle = Duration.seconds(1);
    const maxUnsent = options.maxUnsent ?? SINK_MAX_UNSENT;
    const batchBytes = options.batchBytes ?? SINK_BATCH_BYTES;
    const backfillPause = options.backfillPause ?? SINK_BACKFILL_PAUSE;
    const outbox: Outbox = yield* Effect.acquireRelease(
      Effect.sync(() => openOutbox(options.file, options.keepsConfirmed)),
      (opened) => Effect.sync(() => opened.close()),
    );
    /** One permit: a recorded event wakes the sender, and any number of them wake it once. */
    const wake = yield* Queue.sliding<true>(1);
    /** Each thread's workspace, as its upserts said, for the events that name only the thread. */
    const workspaces = new Map<string, string>();
    const models = new Map<string, string>();
    const askNotes = new Map<string, AskNote>();
    const answerNotes = new Map<string, AnswerNote>();
    /** Who started each thread, as far as anyone was signed in to say. */
    const creators = yield* Effect.try(() => outbox.creators()).pipe(
      Effect.catch(() => Effect.succeed(new Map<string, string>())),
    );
    const createdBy = (threadId: string) => {
      const person = creators.get(threadId);
      return person === undefined ? {} : { createdBy: person };
    };
    /** True while the sink is being made: a `sink.started` then is the server's own start. */
    let booting = true;
    let refreshCards: ((workspaceId: WorkspaceId) => Effect.Effect<void>) | undefined;
    let on = false;
    let checkedAt = Number.NEGATIVE_INFINITY;

    const append = (events: ReadonlyArray<SinkRecord>) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        return yield* Effect.try(() => {
          outbox.append(events.map((event) => ({ ...event, at })));
          return outbox.last() - outbox.confirmed();
        }).pipe(
          Effect.catch((error) =>
            Effect.logError("event sink: an event could not be recorded").pipe(
              Effect.annotateLogs({ reason: String(error.cause) }),
              Effect.as(0),
            ),
          ),
        );
      });

    const write = (events: ReadonlyArray<SinkRecord>): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (events.length === 0) return;
        const unsent = yield* append(events);
        if (unsent > maxUnsent) {
          // The receiver has taken nothing for this long: what waits is given up rather than
          // kept without end, and a new source opens with every thread as it is now.
          yield* Effect.logError("event sink: too many events unsent; new source").pipe(
            Effect.annotateLogs({ unsent }),
          );
          yield* newSource("unsent");
        }
        yield* Queue.offer(wake, true);
      });

    /** The worker questions whose asks are open at the receiver, by ask id. */
    const openQuestions = new Map<
      string,
      { readonly threadId: ThreadId; readonly workspaceId: WorkspaceId }
    >();

    /**
     * The asks of `workspaceId`'s worker questions (every workspace's without one) that changed:
     * opened for one now waiting on the user, resolved for one that waited and no longer does.
     */
    const questionEvents = (workspaceId?: WorkspaceId) =>
      Effect.gen(function* () {
        if (options.workerQuestions === undefined) return [];
        const questions = yield* options.workerQuestions(workspaceId);
        const events: Array<SinkRecord> = [];
        const waiting = new Set<string>();
        for (const question of questions) {
          if (!isUsersQuestion(question)) continue;
          const id = workerQuestionAskId(question.workspaceId, question.id);
          waiting.add(id);
          if (openQuestions.has(id)) continue;
          openQuestions.set(id, { threadId: question.threadId, workspaceId: question.workspaceId });
          events.push({
            type: "ask.opened",
            threadId: question.threadId,
            workspaceId: question.workspaceId,
            data: workerQuestionAsk(question),
          });
        }
        const byId = new Map(
          questions.map((question) => [
            workerQuestionAskId(question.workspaceId, question.id),
            question,
          ]),
        );
        for (const [id, where] of openQuestions) {
          if (waiting.has(id)) continue;
          if (workspaceId !== undefined && where.workspaceId !== workspaceId) continue;
          openQuestions.delete(id);
          const closed = byId.get(id);
          const how = closed === undefined ? "withdrawn" : workerQuestionHow(closed);
          const answer = answerNotes.get(id);
          answerNotes.delete(id);
          const by = how === "answered" ? answer?.answeredBy : undefined;
          events.push({
            type: "ask.resolved",
            threadId: where.threadId,
            workspaceId: where.workspaceId,
            ...(by === undefined ? {} : { actor: { kind: "person" as const, id: by } }),
            data: {
              id,
              how,
              ...(by === undefined ? {} : { answeredBy: by }),
              ...(by === undefined || answer?.proof === undefined ? {} : { proof: answer.proof }),
            },
          });
        }
        return events;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("event sink: worker questions could not be read", cause).pipe(
            Effect.as([] as ReadonlyArray<SinkRecord>),
          ),
        ),
      );

    /** `sink.started`, then an `ask.opened` for each worker question waiting on the user. */
    const opening = Effect.gen(function* () {
      openQuestions.clear();
      const asks = yield* questionEvents();
      const first = yield* started;
      return [
        {
          ...first,
          data: {
            ...first.data,
            openAsks: [...first.data.openAsks, ...openQuestions.keys()],
          },
        },
        ...asks,
      ];
    });

    const started = Effect.gen(function* () {
      const threads = yield* options.threads;
      for (const thread of threads) {
        if (thread.workspaceId !== undefined) workspaces.set(thread.id, thread.workspaceId);
        models.set(thread.id, thread.model.model);
      }
      // A server drops every card when it starts, whatever its store still lists at this point.
      const openAsks = booting ? [] : yield* options.openAsks ?? Effect.succeed([]);
      return {
        type: "sink.started",
        actor: { kind: "system" },
        data: {
          ...(booting ? { restarted: true } : {}),
          threads: threads.map((thread) => ({
            ...threadData(thread),
            ...createdBy(thread.id),
            ...(thread.workspaceId === undefined ? {} : { workspaceId: thread.workspaceId }),
          })),
          openAsks,
        },
      } satisfies SinkRecord;
    });

    /**
     * Drops what the outbox holds and starts a source at 1 with the opening snapshot. The
     * snapshot puts the threads and cards right; the messages are the backfill's to put right,
     * and `forget` says how many are owed (`Outbox.restart`).
     */
    const newSource = (forget: "unsent" | "all"): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Cleared first, then the snapshot: what is recorded while the threads are read is kept.
        const cleared = yield* Effect.try(() => {
          outbox.restart(forget);
          // What was sent under the old source may not have arrived: nothing counts as sent.
          sentMessages.clear();
        }).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logError("event sink: a new source could not be started").pipe(
              Effect.annotateLogs({ reason: String(error.cause) }),
              Effect.as(false),
            ),
          ),
        );
        if (cleared) yield* append(yield* opening);
      });

    /** Whether the sink is on; turning on opens with a snapshot. */
    const isOn = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      // Off is asked again every time, so turning on loses nothing to the wait; on is asked at
      // most once per `recheck`, which only makes turning off take that long.
      if (on && now - checkedAt < Duration.toMillis(recheck)) return on;
      checkedAt = now;
      const next = yield* options.on;
      if (next && !on) {
        on = true;
        yield* write(yield* opening);
      }
      on = next;
      return on;
    });

    const record: EventSinkShape["record"] = (event) =>
      Effect.gen(function* () {
        if (yield* isOn) yield* write([event]);
      });

    const scoped = (threadId: ThreadId) => {
      const workspaceId = workspaces.get(threadId);
      return { threadId, ...(workspaceId === undefined ? {} : { workspaceId }) };
    };

    /** What a server event is to the sink; most are for windows alone and are nothing. */
    const eventsOf = (event: ServerEvent): ReadonlyArray<SinkRecord> => {
      // A removed thread's messages went with it: a thread reopened under its id starts over.
      if (event.type === "thread.removed") {
        for (const key of sentMessages.keys()) {
          if (key.startsWith(`${event.threadId} `)) sentMessages.delete(key);
        }
        if (backfilling) removed.add(event.threadId);
      }
      switch (event.type) {
        case "thread.upsert": {
          const { thread } = event;
          if (thread.workspaceId === undefined) workspaces.delete(thread.id);
          else workspaces.set(thread.id, thread.workspaceId);
          models.set(thread.id, thread.model.model);
          return [
            {
              type: "thread.upsert",
              ...scoped(thread.id),
              data: { ...threadData(thread), ...createdBy(thread.id) },
            },
          ];
        }
        case "thread.removed": {
          const where = scoped(event.threadId);
          workspaces.delete(event.threadId);
          models.delete(event.threadId);
          if (creators.delete(event.threadId)) {
            try {
              outbox.setCreator(event.threadId, undefined);
            } catch {
              // Left in the file: it names a thread that no longer is, and nothing reads it.
            }
          }
          return [{ type: "thread.removed", ...where, data: { id: event.threadId } }];
        }
        case "thread.status":
          return [
            {
              type: "thread.status",
              ...scoped(event.threadId),
              data: {
                id: event.threadId,
                status: event.status,
                idle: IDLE_STATUSES.has(event.status),
              },
            },
          ];
        case "thread.request": {
          const { request } = event;
          const note = askNotes.get(request.id);
          return [
            {
              type: "ask.opened",
              ...scoped(event.threadId),
              data: {
                id: request.id,
                kind: request.kind,
                title: note?.title ?? askTitle(request),
                ...(request.kind === "approval" ? { toolName: request.toolName } : {}),
                ...askContent(request),
                ...(note === undefined ? {} : { decisionId: note.decisionId }),
                ...(note?.assignees === undefined ? {} : { assignees: note.assignees }),
              },
            },
          ];
        }
        case "thread.requestResolved": {
          askNotes.delete(event.requestId);
          const answer = answerNotes.get(event.requestId);
          answerNotes.delete(event.requestId);
          return [
            {
              type: "ask.resolved",
              ...scoped(event.threadId),
              ...(answer?.answeredBy === undefined
                ? {}
                : { actor: { kind: "person" as const, id: answer.answeredBy } }),
              data: {
                id: event.requestId,
                // Resolved with no answer on record: nobody answered it.
                how: answer === undefined ? "withdrawn" : "answered",
                ...(answer?.decision === undefined ? {} : { decision: answer.decision }),
                ...(answer?.answeredBy === undefined ? {} : { answeredBy: answer.answeredBy }),
                ...(answer?.proof === undefined ? {} : { proof: answer.proof }),
              },
            },
          ];
        }
        case "thread.usage": {
          const { tokens, costUsd } = event.usage;
          const model = models.get(event.threadId);
          return [
            {
              type: "usage",
              ...scoped(event.threadId),
              data: {
                ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
                ...(model === undefined ? {} : { model }),
                inputTokens: tokens.inputTokens,
                outputTokens: tokens.outputTokens,
                ...(tokens.cacheReadTokens === undefined
                  ? {}
                  : { cacheReadTokens: tokens.cacheReadTokens }),
                ...(tokens.cacheWriteTokens === undefined
                  ? {}
                  : { cacheWriteTokens: tokens.cacheWriteTokens }),
                ...(costUsd === undefined ? {} : { costUsd }),
              },
            },
          ];
        }
        default:
          return [];
      }
    };

    /** True while the backfill has threads left; `removed` is kept only then. */
    let backfilling = false;
    /** Threads removed while the backfill ran: it sends nothing of them after their removal. */
    const removed = new Set<string>();
    /** What each message last sent held, so a save that changed nothing isn't sent again. */
    const sentMessages = new Map<string, string>();
    /** Whether `stored` is to be sent: it is, unless it last went holding what it holds now. */
    const owed = (threadId: ThreadId, stored: StoredMessage, again: boolean): boolean => {
      const key = `${threadId} ${stored.message.id}`;
      const held = createHash("sha256")
        .update(JSON.stringify([stored.role, stored.turnId ?? null, stored.message]))
        .digest("base64");
      if (!again && sentMessages.get(key) === held) return false;
      sentMessages.delete(key);
      sentMessages.set(key, held);
      if (sentMessages.size > SENT_MESSAGES_KEPT) {
        sentMessages.delete(sentMessages.keys().next().value!);
      }
      return true;
    };
    const messageRecord = (
      threadId: ThreadId,
      stored: StoredMessage,
      now: number,
      again: boolean,
    ) => (owed(threadId, stored, again) ? [messageEvent(scoped(threadId), stored, now)] : []);

    /** Records what a stored message, or a thread's every stored message, is now. */
    const recordMessages = (event: OwnEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const read = options.messages;
        if (read === undefined) return;
        if (event.type === "message.settled") {
          const now = yield* Clock.currentTimeMillis;
          // Gone already (a rewind, a send taken back): there is nothing of it to send.
          const stored = yield* read(event.threadId, { messageId: event.messageId });
          yield* write(stored.flatMap((one) => messageRecord(event.threadId, one, now, false)));
          return;
        }
        let afterSeq = 0;
        while (true) {
          const now = yield* Clock.currentTimeMillis;
          const page = yield* read(event.threadId, { afterSeq, limit: MESSAGES_PAGE });
          yield* write(page.flatMap((one) => messageRecord(event.threadId, one, now, true)));
          if (page.length < MESSAGES_PAGE) return;
          afterSeq = page.at(-1)!.seq;
        }
      });

    // With no window watching, nothing else reconciles a workspace's feature cards. A ledger
    // moves in bursts, so the workspaces that moved collect for a moment and are each read once.
    const movedWorkspaces = new Set<WorkspaceId>();
    const cardsWake = yield* Queue.sliding<true>(1);
    yield* Effect.gen(function* () {
      while (true) {
        yield* Queue.take(cardsWake);
        yield* Effect.sleep(cardsSettle);
        const moved = [...movedWorkspaces];
        movedWorkspaces.clear();
        const refresh = refreshCards;
        if (refresh === undefined) continue;
        yield* Effect.forEach(
          moved,
          (workspaceId) => refresh(workspaceId).pipe(Effect.catchCause(() => Effect.void)),
          { discard: true },
        );
      }
    }).pipe(Effect.forkScoped);

    // Asked once before anything is recorded, so the first events don't race the first answer.
    yield* isOn;
    booting = false;

    if (options.events !== undefined) {
      yield* options.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (!(yield* isOn)) return;
            if (isOwnEvent(event)) return yield* recordMessages(event);
            yield* write(eventsOf(event));
            if (event.type === "orchestration.changed") {
              yield* write(yield* questionEvents(event.workspaceId));
              movedWorkspaces.add(event.workspaceId);
              yield* Queue.offer(cardsWake, true);
            }
          }).pipe(
            // One event that can't be read must not end the recording of the ones after it.
            Effect.catchCause((cause) =>
              Effect.logError("event sink: an event could not be read", cause),
            ),
          ),
        ),
        Effect.forkScoped,
      );
    }

    /** Sends one batch: `sent` when the receiver took something, `empty` with nothing to send. */
    const sendOnce = Effect.gen(function* () {
      const confirmed = outbox.confirmed();
      const held: ReadonlyArray<SinkEvent> = outbox.after(confirmed, batchSize);
      if (held.length === 0) return "empty" as const;
      let events = held;
      if (options.messages !== undefined) {
        let bytes = 0;
        const fits = held.findIndex(
          (event) => (bytes += JSON.stringify(event).length) > batchBytes,
        );
        if (fits !== -1) events = held.slice(0, Math.max(1, fits));
      }
      const source = outbox.source();
      const batch: SinkBatch = { v: EMBEDDING_WIRE_VERSION, source, events };
      const answer = yield* postJson(options.endpoint, batch, options.timeoutMs ?? 30_000).pipe(
        Effect.map(decodeAck),
        Effect.catch((error) =>
          Effect.logWarning("event sink: a batch was not delivered").pipe(
            Effect.annotateLogs({ reason: error.message, from: events[0]!.seq }),
            Effect.as(Option.none<SinkAck>()),
          ),
        ),
      );
      if (Option.isNone(answer)) return "failed" as const;
      const { ack } = answer.value;
      // A new source began while this was in flight: the ack is for the old one's numbers.
      if (outbox.source() !== source) return "failed" as const;
      const sentTo = events.at(-1)!.seq;
      if (ack > sentTo) {
        // An ack past what this batch carried confirms events the receiver was never sent. It is
        // not believed, and nothing is dropped for it: the same batch goes again after a wait.
        yield* Effect.logWarning("event sink: the receiver acked past what it was sent").pipe(
          Effect.annotateLogs({ ack, sentTo }),
        );
        return "failed" as const;
      }
      if (!outbox.confirm(ack)) {
        // The receiver wants what is no longer here: its sequence and this one can't be joined,
        // so a new one starts, opening with every thread.
        yield* Effect.logError("event sink: the receiver's ack can't be answered; new source").pipe(
          Effect.annotateLogs({ ack, last: outbox.last(), confirmed }),
        );
        // By its own word it no longer holds events it had confirmed, and those are no longer
        // here to send again. Any of them may have been a message, so every message is owed.
        yield* newSource("all");
        return "failed" as const;
      }
      return ack > confirmed ? ("sent" as const) : ("failed" as const);
    });

    yield* Effect.gen(function* () {
      let wait = retryBase;
      while (true) {
        // The outbox is a file: a read or write of it that throws is a failed send, tried again
        // after the wait, never the end of sending.
        const outcome = yield* Effect.gen(function* () {
          if (!(yield* isOn)) return "off" as const;
          return yield* sendOnce;
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logError("event sink: a send could not be made", cause).pipe(
                  Effect.as("failed" as const),
                ),
          ),
        );
        if (outcome === "off") {
          yield* Effect.sleep(recheck);
        } else if (outcome === "sent") {
          wait = retryBase;
        } else if (outcome === "empty") {
          wait = retryBase;
          yield* Queue.take(wake).pipe(Effect.timeoutOption(recheck));
        } else {
          yield* Effect.sleep(wait);
          wait = Duration.min(Duration.times(wait, 2), retryMax);
        }
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logError("event sink: the sender stopped", cause)),
      Effect.forkScoped,
    );

    // The backfill: the messages stored before any were sent, each open thread's once, oldest
    // thread first. The outbox keeps which threads are left and how far the first has got, moved
    // in the transaction that records a page, so a restart reads on from the last page recorded.
    // A page is recorded only once the receiver holds everything before it, so what happens
    // meanwhile waits behind one page at most, and a receiver that is down is owed no more.
    const read = options.messages;
    if (read !== undefined) {
      const step = Effect.gen(function* () {
        if (!(yield* isOn)) return "wait" as const;
        if (!outbox.backfillPlanned()) {
          const threads = yield* options.threads;
          outbox.planBackfill(
            threads
              // A thread this sink has yet to hear of is new, and its messages are sent as they
              // settle, after its `thread.upsert`.
              .filter((thread) => models.has(thread.id))
              .toSorted((a, b) => a.createdAt - b.createdAt)
              .map((thread) => thread.id),
          );
        }
        const next = outbox.backfillNext();
        backfilling = next !== undefined;
        if (next === undefined) {
          removed.clear();
          return "done" as const;
        }
        if (outbox.last() > outbox.confirmed()) return "wait" as const;
        const threadId = next.threadId as ThreadId;
        const page = yield* read(threadId, { afterSeq: next.afterSeq, limit: MESSAGES_PAGE });
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.sync(() => {
          // Removed since the page was read: its `thread.removed` is recorded or about to be,
          // and a receiver that deleted its messages is sent none after.
          if (removed.has(threadId)) return outbox.appendBackfill(threadId, [], "done");
          // As many as one batch carries, and one at least.
          let bytes = 0;
          let taken = 0;
          const events: Array<SinkEventInput> = [];
          for (const stored of page) {
            const event = messageEvent(scoped(threadId), stored, now);
            bytes += JSON.stringify(event).length;
            if (taken > 0 && bytes > batchBytes) break;
            taken++;
            // One that went as it changed, while this waited its turn, is at the receiver as it
            // is now.
            if (owed(threadId, stored, false)) events.push({ ...event, at: now });
          }
          outbox.appendBackfill(
            threadId,
            events,
            taken === page.length && page.length < MESSAGES_PAGE ? "done" : page[taken - 1]!.seq,
          );
        });
        yield* Queue.offer(wake, true);
        return "wait" as const;
      });
      yield* Effect.gen(function* () {
        while (true) {
          const outcome = yield* step.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logError("event sink: stored messages could not be sent", cause).pipe(
                    Effect.as("failed" as const),
                  ),
            ),
          );
          // Done until a new source owes the receiver messages again, which is rare: asked at
          // the pace the setting is.
          yield* Effect.sleep(
            outcome === "done" ? recheck : outcome === "failed" ? retryMax : backfillPause,
          );
        }
      }).pipe(Effect.forkScoped);
    }

    return {
      record,
      noteAsk: (requestId, note) => Effect.sync(() => void askNotes.set(requestId, note)),
      noteCreator: (threadId, person) =>
        Effect.sync(() => {
          creators.set(threadId, person);
          try {
            outbox.setCreator(threadId, person);
          } catch {
            // Known for this run of the server, and not after it.
          }
        }),
      noteAnswer: (requestId, note) =>
        Effect.sync(() => {
          answerNotes.delete(requestId);
          if (note === undefined) return;
          answerNotes.set(requestId, note);
          if (answerNotes.size > ANSWER_NOTES_KEPT) {
            answerNotes.delete(answerNotes.keys().next().value!);
          }
        }),
      featureCards: (cards) =>
        Effect.gen(function* () {
          if (!(yield* isOn)) return;
          yield* write(
            cards.map((card) => ({
              type: "featureCard.upsert" as const,
              workspaceId: card.workspaceId,
              data: {
                id: `${card.workspaceId}/${card.feature}`,
                title: card.feature,
                status: card.station,
                version: card.version,
                ...(card.paused === true ? { paused: true } : {}),
                workers: card.workers.map((worker) => worker.threadId),
              },
            })),
          );
        }),
      setFeatureCardRefresh: (refresh) =>
        Effect.sync(() => {
          refreshCards = refresh;
        }),
    };
  });

/** The server events the sink records something of. */
const recorded = (event: ServerEvent): boolean =>
  event.type === "thread.upsert" ||
  event.type === "thread.removed" ||
  event.type === "thread.status" ||
  event.type === "thread.request" ||
  event.type === "thread.requestResolved" ||
  event.type === "thread.usage" ||
  event.type === "orchestration.changed";

/** The file the sink's outbox is kept in, beside the server's database. */
export const eventSinkFile = (dataDir: string): string => join(dataDir, "event-sink.db");

export class EventSink extends Context.Service<EventSink, EventSinkShape>()(
  "@gram/server/EventSink",
) {
  /** Records nothing: what a server with no endpoint runs. */
  static readonly off: EventSinkShape = {
    record: () => Effect.void,
    noteAsk: () => Effect.void,
    noteAnswer: () => Effect.void,
    noteCreator: () => Effect.void,
    featureCards: () => Effect.void,
    setFeatureCardRefresh: () => Effect.void,
  };

  /** From the server's config and settings; `off` with no endpoint configured. */
  static readonly layer: Layer.Layer<EventSink, never, ServerConfig | ThreadStore | EventHub> =
    Layer.effect(
      EventSink,
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        if (config.eventSink === undefined) return EventSink.off;
        if (config.eventSink === ENDPOINT_UNUSABLE) {
          yield* Effect.logError(
            "event sink: GRAM_EVENT_SINK_URL or its token can't be used; nothing is recorded or sent",
          );
          return EventSink.off;
        }
        const store = yield* ThreadStore;
        const hub = yield* EventHub;
        const inMemory = config.databaseFile === ":memory:";
        if (!inMemory) mkdirSync(config.dataDir, { recursive: true });
        return yield* makeEventSink({
          endpoint: config.eventSink,
          file: inMemory ? ":memory:" : eventSinkFile(config.dataDir),
          on: store.getSettings.pipe(Effect.map(embeddingOn)),
          threads: store.listThreads,
          openAsks: store.listThreads.pipe(
            Effect.flatMap(
              Effect.forEach((thread) => store.listRequests(thread.id), { concurrency: 8 }),
            ),
            Effect.map((lists) => lists.flat().map((request) => request.id)),
          ),
          workerQuestions: (workspaceId) =>
            Effect.gen(function* () {
              const ids =
                workspaceId === undefined
                  ? (yield* store.listWorkspaces).map((state) => state.workspace.id)
                  : [workspaceId];
              const lists = yield* Effect.forEach(
                ids,
                (id) =>
                  store
                    .getOutbox(id)
                    .pipe(
                      Effect.map((row) =>
                        questionsOf(readStoredOutbox(row).state).map(publicQuestion),
                      ),
                    ),
                { concurrency: 4 },
              );
              return lists.flat();
            }),
          // Messages are sent only where the deployment asked: otherwise the hub's word of them
          // is never queued here, and the sink records what it did before there was any.
          events:
            config.eventSinkMessages === true
              ? hub.ownEvents((event) => isOwnEvent(event) || recorded(event), "event sink")
              : hub.internalEvents(recorded, "event sink"),
          ...(config.eventSinkMessages === true ? { messages: store.storedMessages } : {}),
        });
      }),
    );
}
