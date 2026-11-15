import { describe, expect, it } from "@effect/vitest";
import type {
  AnswerWorkerQuestionInput,
  SinkBatch,
  SinkEvent,
  ThreadId,
  WorkerQuestion,
  WorkspaceId,
} from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OwnEvent } from "../events/event-hub.ts";
import { answerWorkerQuestion, type AskAnswerDeps } from "./ask-answer.ts";
import type { AnswerProof } from "./answer-proof.ts";
import { type AnswerNote, makeEventSink } from "./event-sink.ts";
import {
  parseWorkerQuestionAskId,
  workerQuestionAnswerText,
  workerQuestionAsk,
  workerQuestionAskId,
  workerQuestionHow,
} from "./worker-question-asks.ts";

const workspaceId = "ws-1" as WorkspaceId;
const threadId = "worker-1" as ThreadId;

const question = (overrides: Partial<WorkerQuestion> = {}): WorkerQuestion => ({
  id: "WQ7",
  workspaceId,
  threadId,
  feature: "cart",
  title: "Cart API",
  question: "Should a deleted cart answer 404 or 410?",
  options: [{ label: "404", description: "What it does today" }, { label: "410" }],
  recommended: "410",
  askedAt: 1,
  stage: "forwarded",
  triageUntil: 2,
  ...overrides,
});

describe("a worker question as an ask", () => {
  it("has an id naming its workspace, read back only from such an id", () => {
    const id = workerQuestionAskId(workspaceId, "WQ7");
    expect(id).toBe("wq:ws-1:WQ7");
    expect(parseWorkerQuestionAskId(id)).toEqual({ workspaceId, questionId: "WQ7" });
    expect(parseWorkerQuestionAskId("wq:a:b:WQ12")).toEqual({
      workspaceId: "a:b",
      questionId: "WQ12",
    });
    for (const other of ["req-1", "wq:", "wq:ws-1:", "wq:ws-1:Q7", "wq::WQ7"]) {
      expect(parseWorkerQuestionAskId(other)).toBeUndefined();
    }
  });

  it("opens with one question keyed by the worker's words, its choices and its recommendation", () => {
    expect(workerQuestionAsk(question({ context: "Clients cache 404s.", note: "Go 410" }))).toEqual(
      {
        id: "wq:ws-1:WQ7",
        kind: "question",
        title: "Cart API asks",
        workerQuestion: "WQ7",
        questions: [
          {
            question: "Should a deleted cart answer 404 or 410?",
            header: "WQ7",
            options: [{ label: "404", description: "What it does today" }, { label: "410" }],
            multiSelect: false,
          },
        ],
        context: "Clients cache 404s. Orchestrator: Go 410",
        recommended: "410",
      },
    );
    // Too large to carry whole: no questions, and the receiver sends the person to the thread.
    expect(
      workerQuestionAsk(question({ question: "q".repeat(4001) }))["questions"],
    ).toBeUndefined();
  });

  it("takes the answer given for its words, and resolves answered only for the user's answer", () => {
    const asked = question();
    expect(
      workerQuestionAnswerText(asked, {
        kind: "question",
        answers: { [asked.question]: ["410", " and log it "] },
      }),
    ).toBe("410, and log it");
    expect(workerQuestionAnswerText(asked, { kind: "question", answers: { other: ["404"] } })).toBe(
      "404",
    );
    expect(
      workerQuestionAnswerText(asked, { kind: "question", answers: { [asked.question]: [" "] } }),
    ).toBeUndefined();
    expect(workerQuestionHow({ stage: "answered", closedBy: "user" })).toBe("answered");
    expect(workerQuestionHow({ stage: "answered", closedBy: "orchestrator" })).toBe("withdrawn");
    expect(workerQuestionHow({ stage: "dismissed", closedBy: "user" })).toBe("withdrawn");
  });
});

const proof: AnswerProof = { statement: "s", method: "POST", path: "/asks/answer", body: "{}" };
const fakeDeps = (found: WorkerQuestion | undefined, reach = true, fails?: string) => {
  const answered: Array<AnswerWorkerQuestionInput> = [];
  const notes: Array<[string, AnswerNote | undefined]> = [];
  const deps: AskAnswerDeps = {
    runtimes: { respond: () => Effect.die("not a harness ask") },
    store: { appendActorEvents: () => Effect.succeed(0) },
    noteAnswer: (id, note) => Effect.sync(() => void notes.push([id, note])),
    workerQuestions: {
      find: () => Effect.succeed(found),
      answer: (input, options) =>
        options.onlyIfOpen !== true
          ? Effect.die("an ask's answer must be the one that closes it")
          : fails === undefined
            ? Effect.sync(() => {
                answered.push(input);
                return question({ stage: "answered", closedBy: "user", answer: input.answer });
              })
            : Effect.fail({ _tag: "InvalidState", message: fails }),
      mayReach: () => Effect.succeed(reach),
    },
  };
  return { deps, answered, notes };
};

describe("answering a worker question's ask", () => {
  const asked = { workspaceId, questionId: "WQ7" };
  const answer = {
    kind: "question" as const,
    answers: { "Should a deleted cart answer 404 or 410?": ["410"] },
  };

  it.effect("answers it as the person, keeping who and the proof for its resolution", () =>
    Effect.gen(function* () {
      const { deps, answered, notes } = fakeDeps(question());
      expect(
        yield* answerWorkerQuestion(deps, asked, threadId, answer, "ada", proof),
      ).toBeUndefined();
      expect(answered).toEqual([{ workspaceId, questionId: "WQ7", answer: "410" }]);
      expect(notes).toEqual([["wq:ws-1:WQ7", { answeredBy: "ada", proof }]]);
    }),
  );

  it.effect(
    "refuses another thread's, an unreachable one, a wrong kind, and takes back a failed one",
    () =>
      Effect.gen(function* () {
        const other = fakeDeps(question({ threadId: "worker-2" as ThreadId }));
        expect(
          (yield* answerWorkerQuestion(other.deps, asked, threadId, answer, "ada", proof))?.status,
        ).toBe(404);
        const far = fakeDeps(question(), false);
        expect(
          (yield* answerWorkerQuestion(far.deps, asked, threadId, answer, "ada", proof))?.status,
        ).toBe(403);
        expect(far.answered).toEqual([]);
        const approval = fakeDeps(question());
        expect(
          (yield* answerWorkerQuestion(
            approval.deps,
            asked,
            threadId,
            { kind: "approval", decision: "allow", scope: "once" },
            "ada",
            proof,
          ))?.status,
        ).toBe(400);
        const closed = fakeDeps(question(), true, "WQ7 is dismissed already by the user.");
        const refused = yield* answerWorkerQuestion(
          closed.deps,
          asked,
          threadId,
          answer,
          "ada",
          proof,
        );
        expect(refused).toMatchObject({
          status: 409,
          message: "WQ7 is dismissed already by the user.",
        });
        expect(closed.notes.at(-1)).toEqual(["wq:ws-1:WQ7", undefined]);
      }),
  );

  it.effect("refuses one answered already, and never notes it as the person's", () =>
    Effect.gen(function* () {
      const done = fakeDeps(question({ stage: "answered", closedBy: "user", answer: "404" }));
      expect(
        (yield* answerWorkerQuestion(done.deps, asked, threadId, answer, "bob", proof))?.status,
      ).toBe(409);
      expect(done.answered).toEqual([]);
      expect(done.notes).toEqual([]);
      const triage = fakeDeps(question({ stage: "triage" }));
      expect(
        (yield* answerWorkerQuestion(triage.deps, asked, threadId, answer, "bob", proof))?.status,
      ).toBe(409);
      expect(triage.notes).toEqual([]);
    }),
  );

  it.live("takes one of two answers at once, and keeps only its person's note", () =>
    Effect.gen(function* () {
      let current = question();
      const notes = new Map<string, AnswerNote>();
      const answered: Array<string> = [];
      const deps: AskAnswerDeps = {
        runtimes: { respond: () => Effect.die("not a harness ask") },
        store: { appendActorEvents: () => Effect.succeed(0) },
        noteAnswer: (id, note) =>
          Effect.sync(() => void (note === undefined ? notes.delete(id) : notes.set(id, note))),
        workerQuestions: {
          find: () => Effect.sync(() => current),
          answer: (input) =>
            Effect.gen(function* () {
              yield* Effect.sleep("5 millis");
              if (current.stage !== "forwarded")
                return yield* Effect.fail({ _tag: "InvalidState", message: "closed" });
              answered.push(input.answer);
              current = question({ stage: "answered", closedBy: "user", answer: input.answer });
              return current;
            }),
          mayReach: () => Effect.succeed(true),
        },
      };
      const [first, second] = yield* Effect.all(
        [
          answerWorkerQuestion(deps, asked, threadId, answer, "ada", proof),
          answerWorkerQuestion(
            deps,
            asked,
            threadId,
            { kind: "question", answers: { [current.question]: ["404"] } },
            "bob",
            proof,
          ),
        ],
        { concurrency: 2 },
      );
      expect(first).toBeUndefined();
      expect(second?.status).toBe(409);
      expect(answered).toEqual(["410"]);
      expect(notes.get("wq:ws-1:WQ7")?.answeredBy).toBe("ada");
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

describe("the event sink's worker question asks", () => {
  it.live("opens a forwarded one, lists it open when it starts, and resolves it as it closed", () =>
    Effect.gen(function* () {
      const to = yield* receiver;
      let questions: Array<WorkerQuestion> = [
        question(),
        question({ id: "WQ8", stage: "triage", question: "Rename the table?" }),
      ];
      const events = yield* Queue.unbounded<OwnEvent>();
      const sink = yield* makeEventSink({
        endpoint: { url: to.url, token: "sink-token" },
        file: ":memory:",
        on: Effect.succeed(true),
        threads: Effect.succeed([]),
        events: Stream.fromQueue(events),
        workerQuestions: (only) =>
          Effect.sync(() =>
            questions.filter((each) => only === undefined || each.workspaceId === only),
          ),
        retryBase: Duration.millis(5),
        retryMax: Duration.millis(20),
        recheck: Duration.millis(5),
      });
      const opened = yield* eventually(
        "the opening",
        Effect.sync(() => to.held.length >= 2 && to.held),
      );
      expect(opened[0]!.type).toBe("sink.started");
      expect(opened[0]!.data["openAsks"]).toEqual(["wq:ws-1:WQ7"]);
      expect(opened[1]).toMatchObject({
        type: "ask.opened",
        threadId,
        workspaceId,
        data: { id: "wq:ws-1:WQ7", kind: "question" },
      });

      // WQ8 is forwarded, and WQ7 answered by a person over HTTP.
      yield* sink.noteAnswer("wq:ws-1:WQ7" as never, { answeredBy: "ada" });
      questions = [
        question({ stage: "answered", closedBy: "user", answer: "410" }),
        question({ id: "WQ8", stage: "forwarded", question: "Rename the table?" }),
      ];
      yield* Queue.offer(events, { type: "orchestration.changed", workspaceId } as never);
      const moved = yield* eventually(
        "the change",
        Effect.sync(() => to.held.length >= 4 && to.held.slice(2)),
      );
      expect(moved.map((event) => [event.type, event.data["id"]])).toEqual([
        ["ask.opened", "wq:ws-1:WQ8"],
        ["ask.resolved", "wq:ws-1:WQ7"],
      ]);
      expect(moved[1]).toMatchObject({
        actor: { kind: "person", id: "ada" },
        data: { how: "answered", answeredBy: "ada" },
      });

      // Withdrawn when its thread left, and gone from the record: withdrawn, naming no one.
      questions = [];
      yield* Queue.offer(events, { type: "orchestration.changed", workspaceId } as never);
      const gone = yield* eventually(
        "the withdrawal",
        Effect.sync(() => to.held.length >= 5 && to.held[4]),
      );
      expect(gone).toMatchObject({
        type: "ask.resolved",
        data: { id: "wq:ws-1:WQ8", how: "withdrawn" },
      });
      expect(gone.data["answeredBy"]).toBeUndefined();
    }),
  );
});
