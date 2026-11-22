import type { AnswerProof } from "./answer-proof.ts";
import { errorDetailData, threadData } from "./thread-data.ts";
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
  type MemoryQuestion,
  type OrchestrationPause,
  parseQuestions,
  QUESTIONS_FILE,
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
import { askContent } from "./ask-content.ts";
import { postJson } from "./endpoint.ts";
import { messageEvent } from "./message-event.ts";
import { backfillPage } from "./backfill-page.ts";
import {
  isUsersQuestion,
  workerQuestionAsk,
  workerQuestionAskId,
  workerQuestionHow,
} from "./worker-question-asks.ts";
import { openOutbox, type Outbox, type SinkEventInput } from "./outbox.ts";
import {
  isOrchestratorAsk,
  orchestratorQuestionAsk,
  orchestratorQuestionAskId,
  orchestratorQuestionHow,
} from "./orchestrator-question-asks.ts";
import { OrchestrationMemory } from "../orchestration/memory.ts";
import { type OpenAsk, openAsksOf } from "./open-asks.ts";

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

const ANSWER_NOTES_KEPT = 1000;

export interface EventSinkShape {
  /** Records one event, if the sink is on. Never fails: a sink that can't write logs it. */
  record(event: SinkRecord): Effect.Effect<void>;
  /**
   * Kept for the `ask.opened` of the approval `requestId` of `threadId`, which is published after
   * this. A card's note is its thread's: another thread's card of the same id never reads it.
   */
  noteAsk(requestId: RequestId, note: AskNote, threadId: ThreadId): Effect.Effect<void>;
  /**
   * A person is answering `requestId`: kept for its `ask.resolved`, which is published after
   * this. `undefined` takes it back, for an answer that wasn't taken. A card's answer is noted
   * under its `threadId`; a question's ask id (with no thread) is its own scope.
   */
  noteAnswer(
    requestId: RequestId,
    note: AnswerNote | undefined,
    threadId?: ThreadId,
  ): Effect.Effect<void>;
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
  /**
   * How the sink tells which of a thread's stored messages are still streaming, stored only in
   * part: the backfill leaves each to be sent when it settles. Set once, by the runtimes.
   */
  setStreaming(streaming: (threadId: ThreadId) => ReadonlySet<string>): Effect.Effect<void>;
}

/** A workspace's orchestrator as the sink reads it (`EventSinkOptions.orchestrators`). */
export interface SinkOrchestrator {
  readonly workspaceId: WorkspaceId;
  /** Absent for a workspace with no orchestrator: whatever it asked is withdrawn. */
  readonly thread?: Thread | undefined;
  /** Its orchestrator couldn't be read now: what it asked stays as it was. */
  readonly unread?: true | undefined;
  readonly paused?: OrchestrationPause | undefined;
  readonly questions: ReadonlyArray<MemoryQuestion>;
}

const pauseData = (pause: OrchestrationPause): Record<string, unknown> => ({
  reason: pause.reason,
  at: pause.at,
  ...(pause.detail === undefined ? {} : { detail: pause.detail }),
});

export interface EventSinkOptions {
  readonly endpoint: EndpointConfig;
  /** The outbox's file; `:memory:` for one that goes with the process. */
  readonly file: string;
  /** Whether hosted features are on now; asked again every `recheck`. */
  readonly on: Effect.Effect<boolean>;
  /** Every open thread, for `sink.started`. */
  readonly threads: Effect.Effect<ReadonlyArray<Thread>>;
  /** The cards open now, for a `sink.started` that isn't the server's start. */
  readonly openAsks?: Effect.Effect<ReadonlyArray<OpenAsk>>;
  /**
   * A workspace's worker questions, or every workspace's without one, for the asks of those that
   * wait on the user (`worker-question-asks.ts`). Absent, none is sent.
   */
  readonly workerQuestions?: (
    workspaceId?: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<WorkerQuestion>>;
  /**
   * A workspace's orchestrator, or every workspace's without one: its thread, its pause and the
   * entries of its `questions.md`, for the asks of its open questions
   * (`orchestrator-question-asks.ts`) and the `paused` its `thread.upsert` carries. A workspace
   * left out is gone, and whatever it asked is withdrawn; one that can't be read is `unread`, and
   * a read that fails as a whole changes nothing. Absent, none.
   */
  readonly orchestrators?: (
    workspaceId?: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<SinkOrchestrator>>;
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

const noneStreaming = (): ReadonlySet<string> => new Set();

const MESSAGES_PAGE = 50;

/**
 * The backfill's pace: one page of a thread's stored messages (`MESSAGES_PAGE` of them, or one
 * batch's bytes if that is fewer) each time this has passed and the receiver holds everything
 * recorded so far.
 */
export const SINK_BACKFILL_PAUSE = Duration.millis(500);

const SENT_MESSAGES_KEPT = 5000;

const askTitle = (request: PendingRequest): string => {
  if (request.kind === "approval") {
    return `${request.displayName}: ${approvalSubject(request)}`.slice(0, 300);
  }
  if (request.kind === "question") return request.questions[0]?.question ?? "Question";
  return "Plan";
};

const IDLE_STATUSES: ReadonlySet<string> = new Set(["idle", "cold"]);

const decodeAck = Schema.decodeUnknownOption(SinkAck);

const noteKey = (id: string, threadId?: ThreadId) =>
  threadId === undefined ? id : JSON.stringify([threadId, id]);

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
    const wake = yield* Queue.sliding<true>(1);
    const workspaces = new Map<string, string>();
    const models = new Map<string, string>();
    const pauses = new Map<string, string>();
    const pausedThreads = new Map<WorkspaceId, string>();
    const pausedOf = (threadId: string): Record<string, unknown> => {
      const pause = pauses.get(threadId);
      return pause === undefined ? {} : { paused: JSON.parse(pause) };
    };
    const askNotes = new Map<string, AskNote>();
    const answerNotes = new Map<string, AnswerNote>();
    const creators = yield* Effect.try(() => outbox.creators()).pipe(
      Effect.catch(() => Effect.succeed(new Map<string, string>())),
    );
    const createdBy = (threadId: string) => {
      const person = creators.get(threadId);
      return person === undefined ? {} : { createdBy: person };
    };
    let booting = true;
    let refreshCards: ((workspaceId: WorkspaceId) => Effect.Effect<void>) | undefined;
    let streaming: (threadId: ThreadId) => ReadonlySet<string> = noneStreaming;
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
          yield* Effect.logError("event sink: too many events unsent; new source").pipe(
            Effect.annotateLogs({ unsent }),
          );
          yield* newSource("unsent");
        }
        yield* Queue.offer(wake, true);
      });

    const openOrchestratorAsks = new Map<
      string,
      { readonly threadId: ThreadId; readonly workspaceId: WorkspaceId }
    >();

    const orchestratorEvents = (workspaceId?: WorkspaceId) =>
      Effect.gen(function* () {
        if (options.orchestrators === undefined) return [];
        const orchestrators = yield* options.orchestrators(workspaceId);
        const events: Array<SinkRecord> = [];
        const waiting = new Set<string>();
        const unread = new Set<string>();
        for (const {
          workspaceId: id,
          thread,
          paused,
          questions,
          unread: failed,
        } of orchestrators) {
          if (failed === true) {
            unread.add(id);
            continue;
          }
          const before = pausedThreads.get(id);
          if (before !== undefined && before !== thread?.id) {
            pauses.delete(before);
            pausedThreads.delete(id);
          }
          if (thread === undefined) continue;
          const pause = paused === undefined ? undefined : JSON.stringify(pauseData(paused));
          if (pause !== pauses.get(thread.id)) {
            if (pause === undefined) {
              pauses.delete(thread.id);
              pausedThreads.delete(id);
            } else {
              pauses.set(thread.id, pause);
              pausedThreads.set(id, thread.id);
            }
            workspaces.set(thread.id, id);
            events.push({
              type: "thread.upsert",
              threadId: thread.id,
              workspaceId: id,
              data: { ...threadData(thread), ...createdBy(thread.id), ...pausedOf(thread.id) },
            });
          }
          for (const question of questions) {
            if (!isOrchestratorAsk(question)) continue;
            const askId = orchestratorQuestionAskId(id, question.id);
            waiting.add(askId);
            const open = openOrchestratorAsks.get(askId);
            if (open !== undefined && open.threadId === thread.id) continue;
            if (open !== undefined)
              events.push({
                type: "ask.resolved",
                threadId: open.threadId,
                workspaceId: id,
                data: { id: askId, how: "withdrawn" },
              });
            openOrchestratorAsks.set(askId, { threadId: thread.id, workspaceId: id });
            events.push({
              type: "ask.opened",
              threadId: thread.id,
              workspaceId: id,
              data: orchestratorQuestionAsk(id, question),
            });
          }
        }
        const byId = new Map(
          orchestrators.flatMap(({ workspaceId: id, questions }) =>
            questions.flatMap((question) =>
              question.id === undefined
                ? []
                : [[orchestratorQuestionAskId(id, question.id), question] as const],
            ),
          ),
        );
        for (const [askId, where] of openOrchestratorAsks) {
          if (waiting.has(askId)) continue;
          if (workspaceId !== undefined && where.workspaceId !== workspaceId) continue;
          if (unread.has(where.workspaceId)) continue;
          openOrchestratorAsks.delete(askId);
          const how = orchestratorQuestionHow(byId.get(askId));
          const answer = answerNotes.get(askId);
          answerNotes.delete(askId);
          const by = how === "answered" ? answer?.answeredBy : undefined;
          events.push({
            type: "ask.resolved",
            threadId: where.threadId,
            workspaceId: where.workspaceId,
            ...(by === undefined ? {} : { actor: { kind: "person" as const, id: by } }),
            data: {
              id: askId,
              how,
              ...(by === undefined ? {} : { answeredBy: by }),
              ...(by === undefined || answer?.proof === undefined ? {} : { proof: answer.proof }),
            },
          });
        }
        return events;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("event sink: orchestrators could not be read", cause).pipe(
            Effect.as([] as ReadonlyArray<SinkRecord>),
          ),
        ),
      );

    const openQuestions = new Map<
      string,
      { readonly threadId: ThreadId; readonly workspaceId: WorkspaceId }
    >();

    const questionEvents = (workspaceId?: WorkspaceId) =>
      Effect.gen(function* () {
        const events: Array<SinkRecord> = [];
        events.push(...(yield* orchestratorEvents(workspaceId)));
        if (options.workerQuestions === undefined) return events;
        const questions = yield* options.workerQuestions(workspaceId);
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

    const opening = Effect.gen(function* () {
      openQuestions.clear();
      openOrchestratorAsks.clear();
      pauses.clear();
      pausedThreads.clear();
      const asks = (yield* questionEvents()).filter((event) => event.type !== "thread.upsert");
      const first = yield* started;
      return [
        {
          ...first,
          data: {
            ...first.data,
            openAsks: [
              ...first.data.openAsks,
              ...[...openQuestions.keys(), ...openOrchestratorAsks.keys()].map((id) => ({ id })),
            ],
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
      const openAsks = booting ? [] : yield* options.openAsks ?? Effect.succeed([]);
      return {
        type: "sink.started",
        actor: { kind: "system" },
        data: {
          ...(booting ? { restarted: true } : {}),
          threads: threads.map((thread) => ({
            ...threadData(thread),
            ...createdBy(thread.id),
            ...pausedOf(thread.id),
            ...(thread.workspaceId === undefined ? {} : { workspaceId: thread.workspaceId }),
          })),
          openAsks,
        },
      } satisfies SinkRecord;
    });

    const newSource = (forget: "unsent" | "all"): Effect.Effect<void> =>
      Effect.gen(function* () {
        const cleared = yield* Effect.try(() => {
          outbox.restart(forget);
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

    const isOn = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
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

    const eventsOf = (event: ServerEvent): ReadonlyArray<SinkRecord> => {
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
              data: { ...threadData(thread), ...createdBy(thread.id), ...pausedOf(thread.id) },
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
            } catch (_leftInTheFileItNamesAThreadThat) {}
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
                ...errorDetailData(event.status, event.detail),
              },
            },
          ];
        case "thread.request": {
          const { request } = event;
          const note = askNotes.get(noteKey(request.id, event.threadId));
          return [
            {
              type: "ask.opened",
              ...scoped(event.threadId),
              data: {
                id: request.id,
                kind: request.kind,
                ...(request.shown === undefined ? {} : { shown: request.shown }),
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
          const key = noteKey(event.requestId, event.threadId);
          askNotes.delete(key);
          const answer = answerNotes.get(key);
          answerNotes.delete(key);
          return [
            {
              type: "ask.resolved",
              ...scoped(event.threadId),
              ...(answer?.answeredBy === undefined
                ? {}
                : { actor: { kind: "person" as const, id: answer.answeredBy } }),
              data: {
                id: event.requestId,
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

    let backfilling = false;
    const removed = new Set<string>();
    const sentMessages = new Map<string, string>();
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

    const recordMessages = (event: OwnEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const read = options.messages;
        if (read === undefined) return;
        if (event.type === "message.settled") {
          const now = yield* Clock.currentTimeMillis;
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

    yield* isOn;
    booting = false;

    if (options.events !== undefined) {
      yield* options.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (!(yield* isOn)) return;
            if (isOwnEvent(event)) return yield* recordMessages(event);
            yield* write(eventsOf(event));
            if (event.type === "memory.changed") {
              yield* write(yield* orchestratorEvents(event.workspaceId));
            }
            if (event.type === "orchestration.changed") {
              yield* write(yield* questionEvents(event.workspaceId));
              movedWorkspaces.add(event.workspaceId);
              yield* Queue.offer(cardsWake, true);
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("event sink: an event could not be read", cause),
            ),
          ),
        ),
        Effect.forkScoped,
      );
    }

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
      if (outbox.source() !== source) return "failed" as const;
      const sentTo = events.at(-1)!.seq;
      if (ack > sentTo) {
        yield* Effect.logWarning("event sink: the receiver acked past what it was sent").pipe(
          Effect.annotateLogs({ ack, sentTo }),
        );
        return "failed" as const;
      }
      if (!outbox.confirm(ack)) {
        yield* Effect.logError("event sink: the receiver's ack can't be answered; new source").pipe(
          Effect.annotateLogs({ ack, last: outbox.last(), confirmed }),
        );
        yield* newSource("all");
        return "failed" as const;
      }
      return ack > confirmed ? ("sent" as const) : ("failed" as const);
    });

    yield* Effect.gen(function* () {
      let wait = retryBase;
      while (true) {
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
          yield* Queue.take(wake).pipe(Effect.timeoutOption(recheck));
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

    const read = options.messages;
    if (read !== undefined) {
      const step = Effect.gen(function* () {
        if (!(yield* isOn)) return "wait" as const;
        if (!outbox.backfillPlanned()) {
          const threads = yield* options.threads;
          outbox.planBackfill(
            threads
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
        const streamingBefore = streaming(threadId);
        const page = yield* read(threadId, { afterSeq: next.afterSeq, limit: MESSAGES_PAGE });
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.sync(() => {
          if (removed.has(threadId)) return outbox.appendBackfill(threadId, [], "done");
          const streamingNow = streaming(threadId);
          const taken = backfillPage(
            { page, afterSeq: next.afterSeq, limit: MESSAGES_PAGE },
            {
              streaming: (id) => streamingBefore.has(id) || streamingNow.has(id),
              event: (stored) => messageEvent(scoped(threadId), stored, now),
              batchBytes,
              owed: (stored) => owed(threadId, stored, false),
            },
          );
          outbox.appendBackfill(
            threadId,
            taken.events.map((event) => ({ ...event, at: now })),
            taken.afterSeq,
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
          yield* Effect.sleep(
            outcome === "done" ? recheck : outcome === "failed" ? retryMax : backfillPause,
          );
        }
      }).pipe(Effect.forkScoped);
    }

    return {
      record,
      noteAsk: (requestId, note, threadId) =>
        Effect.sync(() => void askNotes.set(noteKey(requestId, threadId), note)),
      noteCreator: (threadId, person) =>
        Effect.sync(() => {
          creators.set(threadId, person);
          try {
            outbox.setCreator(threadId, person);
          } catch (_knownForThisRunOfTheServerAndNot) {}
        }),
      noteAnswer: (requestId, note, threadId) =>
        Effect.sync(() => {
          const key = noteKey(requestId, threadId);
          answerNotes.delete(key);
          if (note === undefined) return;
          answerNotes.set(key, note);
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
      setStreaming: (ofThread) =>
        Effect.sync(() => {
          streaming = ofThread;
        }),
    };
  });

const recorded = (event: ServerEvent): boolean =>
  event.type === "thread.upsert" ||
  event.type === "thread.removed" ||
  event.type === "thread.status" ||
  event.type === "thread.request" ||
  event.type === "thread.requestResolved" ||
  event.type === "thread.usage" ||
  event.type === "orchestration.changed" ||
  event.type === "memory.changed";

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
    setStreaming: () => Effect.void,
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
        const memory = yield* Effect.gen(function* () {
          return yield* OrchestrationMemory;
        }).pipe(Effect.provide(OrchestrationMemory.layerAt(join(config.dataDir, "orchestration"))));
        const inMemory = config.databaseFile === ":memory:";
        if (!inMemory) mkdirSync(config.dataDir, { recursive: true });
        return yield* makeEventSink({
          endpoint: config.eventSink,
          file: inMemory ? ":memory:" : eventSinkFile(config.dataDir),
          on: store.getSettings.pipe(Effect.map(embeddingOn)),
          threads: store.listThreads,
          openAsks: openAsksOf(store),
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
          orchestrators: (workspaceId) =>
            Effect.gen(function* () {
              const states =
                workspaceId === undefined
                  ? yield* store.listWorkspaces
                  : yield* store.getWorkspace(workspaceId).pipe(
                      Effect.map((state) => [state]),
                      Effect.catchTag("NotFound", () => Effect.succeed([])),
                    );
              const found = yield* Effect.forEach(
                states,
                (state) =>
                  Effect.gen(function* () {
                    const threadId = state.workspace.orchestratorThreadId;
                    if (threadId === undefined) {
                      const none: SinkOrchestrator[] = [
                        { workspaceId: state.workspace.id, questions: [] },
                      ];
                      return none;
                    }
                    const thread = yield* store.getThread(threadId);
                    const content = yield* memory
                      .read(state.workspace.id, QUESTIONS_FILE)
                      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
                    const one: SinkOrchestrator[] = [
                      {
                        workspaceId: state.workspace.id,
                        thread,
                        paused: state.paused,
                        questions: content === undefined ? [] : parseQuestions(content),
                      },
                    ];
                    return one;
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logError("event sink: an orchestrator could not be read", cause).pipe(
                        Effect.as([
                          { workspaceId: state.workspace.id, questions: [], unread: true },
                        ] as SinkOrchestrator[]),
                      ),
                    ),
                  ),
                { concurrency: 4 },
              );
              return found.flat();
            }),
          events:
            config.eventSinkMessages === true
              ? hub.ownEvents((event) => isOwnEvent(event) || recorded(event), "event sink")
              : hub.internalEvents(recorded, "event sink"),
          ...(config.eventSinkMessages === true ? { messages: store.storedMessages } : {}),
        });
      }),
    );
}
