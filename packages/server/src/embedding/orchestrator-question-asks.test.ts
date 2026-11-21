import { describe, expect, it } from "@effect/vitest";
import type {
  MemoryQuestion,
  OrchestrationPause,
  SinkBatch,
  SinkEvent,
  Thread,
  ThreadId,
  WorkspaceId,
} from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OwnEvent } from "../events/event-hub.ts";
import { answerOrchestratorQuestion, type AskAnswerDeps } from "./ask-answer.ts";
import type { AnswerProof } from "./answer-proof.ts";
import { type AnswerNote, makeEventSink } from "./event-sink.ts";
import { parseOrchestratorQuestionAskId } from "./orchestrator-question-asks.ts";

const workspaceId = "ws-1" as WorkspaceId;
const threadId = "orch-1" as ThreadId;
const orchestrator = {
  id: threadId,
  title: "Orchestrator",
  role: "orchestrator",
  model: { agent: "claude", model: "opus" },
} as unknown as Thread;

const entry = (overrides: Partial<MemoryQuestion> = {}): MemoryQuestion => ({
  id: "Q1",
  text: "Which colour?",
  detail: undefined,
  open: true,
  options: [{ label: "blue" }, { label: "red" }],
  ...overrides,
});

const proof: AnswerProof = { statement: "s", method: "POST", path: "/asks/answer", body: "{}" };

describe("an orchestrator question's ask id", () => {
  it("names its workspace and entry, and is read back from no other id", () => {
    expect(parseOrchestratorQuestionAskId("oq:a:b:Q3")).toEqual({
      workspaceId: "a:b",
      questionId: "Q3",
    });
    for (const other of ["req-1", "wq:ws-1:WQ7", "oq:", "oq:ws-1:", "oq::Q1"])
      expect(parseOrchestratorQuestionAskId(other)).toBeUndefined();
  });
});

const fakeDeps = (found: MemoryQuestion | undefined, reach = true, on = threadId) => {
  const answered: Array<{ questionId: string; question: string; answer: string }> = [];
  const notes: Array<[string, AnswerNote | undefined]> = [];
  const deps: AskAnswerDeps = {
    runtimes: { respond: () => Effect.die("not a harness ask") },
    store: { appendActorEvents: () => Effect.succeed(0) },
    noteAnswer: (id, note) => Effect.sync(() => void notes.push([id, note])),
    orchestratorQuestions: {
      find: () =>
        Effect.succeed(found === undefined ? undefined : { question: found, threadId: on }),
      answer: (input, options) =>
        Effect.gen(function* () {
          expect(options.own).toBe(true);
          yield* options.beforeSend;
          answered.push(input);
          return { questionId: input.questionId, delivered: "sent" as const };
        }),
      mayReach: () => Effect.succeed(reach),
    },
  };
  return { deps, answered, notes };
};

describe("answering an orchestrator question's ask", () => {
  const asked = { workspaceId, questionId: "Q1" };
  const answer = { kind: "question" as const, answers: { "Which colour?": ["blue"] } };
  it.effect("answers it as the person, keeping who and the proof for its resolution", () =>
    Effect.gen(function* () {
      const { deps, answered, notes } = fakeDeps(entry());
      expect(
        yield* answerOrchestratorQuestion(deps, asked, threadId, answer, "ada", proof),
      ).toBeUndefined();
      expect(answered).toEqual([
        { workspaceId, questionId: "Q1", question: "Which colour?", answer: "blue" },
      ]);
      expect(notes).toEqual([["oq:ws-1:Q1", { answeredBy: "ada", proof }]]);
    }),
  );

  it.effect("refuses another thread's, an unreachable one, and one closed already", () =>
    Effect.gen(function* () {
      const other = fakeDeps(entry(), true, "orch-2" as ThreadId);
      expect(
        (yield* answerOrchestratorQuestion(other.deps, asked, threadId, answer, "ada", proof))
          ?.status,
      ).toBe(404);
      const far = fakeDeps(entry(), false);
      expect(
        (yield* answerOrchestratorQuestion(far.deps, asked, threadId, answer, "ada", proof))
          ?.status,
      ).toBe(403);
      const closed = fakeDeps(entry({ open: false, closedAs: "answered", answer: "red" }));
      expect(
        (yield* answerOrchestratorQuestion(closed.deps, asked, threadId, answer, "bob", proof))
          ?.status,
      ).toBe(409);
      for (const each of [other, far, closed]) {
        expect(each.answered).toEqual([]);
        expect(each.notes).toEqual([]);
      }
    }),
  );
});

/** A JSON endpoint on loopback that keeps the sink's events in order. */
const receiver = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ server: Server; url: string; held: Array<SinkEvent> }>((resolve) => {
        const held: Array<SinkEvent> = [];
        const server = createServer((request, response) => {
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const batch = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SinkBatch;
            for (const event of batch.events) if (event.seq === held.length + 1) held.push(event);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ ack: held.length }));
          });
        });
        server.listen(0, "127.0.0.1", () =>
          resolve({
            server,
            url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
            held,
          }),
        );
      }),
  ),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
);

const eventually = <A>(label: string, check: Effect.Effect<A | undefined | false>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1000; i++) {
      const value = yield* check;
      if (value !== undefined && value !== false) return value;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

describe("the event sink's orchestrator", () => {
  it.live("opens its open questions as asks, says when it pauses, and resolves what closed", () =>
    Effect.gen(function* () {
      const to = yield* receiver;
      let questions: Array<MemoryQuestion> = [entry(), entry({ id: undefined, text: "No id" })];
      let paused: OrchestrationPause | undefined;
      const events = yield* Queue.unbounded<OwnEvent>();
      const sink = yield* makeEventSink({
        endpoint: { url: to.url, token: "sink-token" },
        file: ":memory:",
        on: Effect.succeed(true),
        threads: Effect.succeed([orchestrator]),
        events: Stream.fromQueue(events),
        orchestrators: () =>
          Effect.sync(() => [{ workspaceId, thread: orchestrator, paused, questions }]),
        retryBase: Duration.millis(5),
        retryMax: Duration.millis(20),
        recheck: Duration.millis(5),
      });
      const opened = yield* eventually(
        "the opening",
        Effect.sync(() => to.held.length >= 2 && to.held),
      );
      // An entry with no id can't be answered by one: it stays in the thread.
      expect(opened[0]!.data["openAsks"]).toEqual([{ id: "oq:ws-1:Q1" }]);
      expect(opened[1]).toMatchObject({
        type: "ask.opened",
        threadId,
        workspaceId,
        data: {
          id: "oq:ws-1:Q1",
          kind: "question",
          questions: [
            { question: "Which colour?", options: [{ label: "blue" }, { label: "red" }] },
          ],
        },
      });

      // The orchestrator pauses: its thread says so, and again with nothing once it resumes.
      paused = { reason: "deliveryFailed", detail: "the orchestrator didn't answer", at: 5 };
      yield* Queue.offer(events, { type: "orchestration.changed", workspaceId } as never);
      const pause = yield* eventually(
        "the pause",
        Effect.sync(() => to.held.length >= 3 && to.held[2]),
      );
      expect(pause).toMatchObject({
        type: "thread.upsert",
        threadId,
        data: { id: threadId, paused: { reason: "deliveryFailed", at: 5 } },
      });

      // Answered by a person over HTTP, then closed in the file.
      yield* sink.noteAnswer("oq:ws-1:Q1" as never, { answeredBy: "ada" });
      paused = undefined;
      questions = [entry({ open: false, closedAs: "answered", answer: "blue" })];
      yield* Queue.offer(events, { type: "memory.changed", workspaceId } as never);
      const moved = yield* eventually(
        "the answer",
        Effect.sync(() => to.held.length >= 5 && to.held.slice(3)),
      );
      expect(moved[0]).toMatchObject({ type: "thread.upsert", threadId });
      expect(moved[0]!.data["paused"]).toBeUndefined();
      expect(moved[1]).toMatchObject({
        type: "ask.resolved",
        actor: { kind: "person", id: "ada" },
        data: { id: "oq:ws-1:Q1", how: "answered", answeredBy: "ada" },
      });
    }),
  );
  it.live(
    "keeps a workspace's asks while it can't be read, and withdraws them once it's gone",
    () =>
      Effect.gen(function* () {
        const to = yield* receiver;
        let state: "read" | "unreadable" | "gone" = "read";
        const events = yield* Queue.unbounded<OwnEvent>();
        yield* makeEventSink({
          endpoint: { url: to.url, token: "sink-token" },
          file: ":memory:",
          on: Effect.succeed(true),
          threads: Effect.succeed([orchestrator]),
          events: Stream.fromQueue(events),
          orchestrators: () =>
            Effect.sync(() =>
              state === "gone"
                ? []
                : state === "unreadable"
                  ? [{ workspaceId, questions: [], unread: true as const }]
                  : [{ workspaceId, thread: orchestrator, questions: [entry()] }],
            ),
          retryBase: Duration.millis(5),
          retryMax: Duration.millis(20),
          recheck: Duration.millis(5),
        });
        yield* eventually(
          "the opening",
          Effect.sync(() => to.held.length >= 2),
        );
        state = "unreadable";
        yield* Queue.offer(events, { type: "memory.changed", workspaceId } as never);
        yield* Effect.sleep("100 millis");
        expect(to.held).toHaveLength(2);
        state = "gone";
        yield* Queue.offer(events, { type: "orchestration.changed", workspaceId } as never);
        const gone = yield* eventually(
          "the withdrawal",
          Effect.sync(() => to.held.length >= 3 && to.held.slice(2)),
        );
        expect(gone).toHaveLength(1);
        expect(gone[0]).toMatchObject({
          type: "ask.resolved",
          data: { id: "oq:ws-1:Q1", how: "withdrawn" },
        });
      }),
  );
});
