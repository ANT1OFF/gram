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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ENDPOINT_UNUSABLE, type EndpointConfig, ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { postJson } from "./endpoint.ts";
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
  /** The server's events to record; absent in a test that records by hand. */
  readonly events?: Stream.Stream<ServerEvent>;
  readonly batchSize?: number;
  /** The first wait after a send that failed or was not taken; it doubles up to `retryMax`. */
  readonly retryBase?: Duration.Duration;
  readonly retryMax?: Duration.Duration;
  readonly recheck?: Duration.Duration;
  readonly timeoutMs?: number;
  /** How many recorded events may wait unconfirmed before the oldest are given up. */
  readonly maxUnsent?: number;
}

/**
 * How many events wait for a receiver that isn't taking them before the sink gives the backlog
 * up, so an endpoint that is down for days can't fill the disk. Giving up starts a new source,
 * which opens with every thread.
 */
export const SINK_MAX_UNSENT = 200_000;

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
    const outbox: Outbox = yield* Effect.acquireRelease(
      Effect.sync(() => openOutbox(options.file)),
      (opened) => Effect.sync(() => opened.close()),
    );
    /** One permit: a recorded event wakes the sender, and any number of them wake it once. */
    const wake = yield* Queue.sliding<true>(1);
    /** Each thread's workspace, as its upserts said, for the events that name only the thread. */
    const workspaces = new Map<string, string>();
    const models = new Map<string, string>();
    const askNotes = new Map<string, AskNote>();
    const answerNotes = new Map<string, AnswerNote>();
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
          yield* newSource;
        }
        yield* Queue.offer(wake, true);
      });

    const started = Effect.gen(function* () {
      const threads = yield* options.threads;
      for (const thread of threads) {
        if (thread.workspaceId !== undefined) workspaces.set(thread.id, thread.workspaceId);
        models.set(thread.id, thread.model.model);
      }
      return {
        type: "sink.started",
        actor: { kind: "system" },
        data: {
          threads: threads.map((thread) => ({
            ...threadData(thread),
            ...(thread.workspaceId === undefined ? {} : { workspaceId: thread.workspaceId }),
          })),
        },
      } satisfies SinkRecord;
    });

    /** Drops what the outbox holds and starts a source at 1 with the opening snapshot. */
    const newSource: Effect.Effect<void> = Effect.gen(function* () {
      // Cleared first, then the snapshot: what is recorded while the threads are read is kept.
      const cleared = yield* Effect.try(() => outbox.restart()).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logError("event sink: a new source could not be started").pipe(
            Effect.annotateLogs({ reason: String(error.cause) }),
            Effect.as(false),
          ),
        ),
      );
      if (cleared) yield* append([yield* started]);
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
        yield* write([yield* started]);
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
      switch (event.type) {
        case "thread.upsert": {
          const { thread } = event;
          if (thread.workspaceId === undefined) workspaces.delete(thread.id);
          else workspaces.set(thread.id, thread.workspaceId);
          models.set(thread.id, thread.model.model);
          return [{ type: "thread.upsert", ...scoped(thread.id), data: threadData(thread) }];
        }
        case "thread.removed": {
          const where = scoped(event.threadId);
          workspaces.delete(event.threadId);
          models.delete(event.threadId);
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

    if (options.events !== undefined) {
      yield* options.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (!(yield* isOn)) return;
            yield* write(eventsOf(event));
            if (event.type === "orchestration.changed") {
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
      const events: ReadonlyArray<SinkEvent> = outbox.after(confirmed, batchSize);
      if (events.length === 0) return "empty" as const;
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
        yield* newSource;
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

    return {
      record,
      noteAsk: (requestId, note) => Effect.sync(() => void askNotes.set(requestId, note)),
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
          events: hub.internalEvents(
            (event) =>
              event.type === "thread.upsert" ||
              event.type === "thread.removed" ||
              event.type === "thread.status" ||
              event.type === "thread.request" ||
              event.type === "thread.requestResolved" ||
              event.type === "thread.usage" ||
              event.type === "orchestration.changed",
            "event sink",
          ),
        });
      }),
    );
}
