import { describe, expect, it } from "@effect/vitest";
import {
  type GramUIMessage,
  type OrchestratorLedger,
  type ThreadId,
  type WorkerQuestion,
  type WorkspaceId,
} from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import type { FakeSession } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Orchestration } from "./service.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  outboxOf,
  settle,
  spawn,
  waitReal,
  waitSent,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";

// Workers' own questions (docs/design/worker-questions.md): asked by a worker, triaged by its
// orchestrator, otherwise answered or dismissed by the user, with the orchestrator's copy.

const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

const QUESTION = {
  question: "Should a deleted cart answer 404 or 410?",
  context: "Clients cache 404s for a day.",
  options: [
    { label: "404", description: "What the API does today" },
    { label: "410", description: "Gone, so clients drop it" },
  ],
  recommended: "410",
};

const partsOf = (messages: ReadonlyArray<GramUIMessage>, type: string) =>
  messages.flatMap((message) => message.parts.filter((part) => part.type === type));

const questionCards = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return partsOf(yield* store.listMessages(threadId), "data-worker-question").map(
      (part) => (part as unknown as { data: WorkerQuestion }).data,
    );
  });

const stored = (workspaceId: WorkspaceId, id: string) =>
  Effect.map(outboxOf(workspaceId), (outbox) =>
    (outbox.questions ?? []).find((question) => question.id === id),
  );

/** An orchestrator with one worker, its brief's turn still running. */
const withWorker = (world: World) =>
  Effect.gen(function* () {
    const opened = yield* openOrchestrator(world);
    const worker = yield* spawn(opened.session, { feature: "cart", title: "Cart API" });
    yield* completeTurn(opened.session);
    return { ...opened, worker };
  });

/** The next digest the orchestrator is sent, once the window has passed; its turn left running. */
const nextDigest = (orchestrator: FakeSession) =>
  Effect.gen(function* () {
    const before = orchestrator.sent.length;
    yield* TestClock.adjust("60 seconds");
    yield* settle;
    const session = yield* waitSent(orchestrator.options.threadId, before + 1);
    return session.sent.at(-1)?.text ?? "";
  });

const asked = (session: FakeSession, input: Record<string, unknown> = QUESTION) =>
  session.callTool("ask_question", input) as Effect.Effect<{
    readonly asked: boolean;
    readonly id: string;
    readonly stage: string;
  }>;

/** A second workspace, its orchestrator with a worker of its own. */
const otherWorkspace = (other: World) =>
  Effect.gen(function* () {
    const orchestration = yield* Orchestration;
    const store = yield* ThreadStore;
    const project = yield* store.ensureProject({ root: other.repo, name: "other" });
    const state = yield* orchestration.saveWorkspace({
      name: "other",
      projectIds: [project.id],
      homeProjectId: project.id,
    });
    const thread = yield* orchestration.open({ workspaceId: state.workspace.id });
    const session = yield* waitSent(thread.id, 1);
    yield* completeTurn(session);
    const worker = yield* spawn(session, {
      project: other.repo,
      feature: "other",
      title: "Other",
    });
    yield* completeTurn(session);
    return { session, worker, workspaceId: state.workspace.id };
  });

/** Two workspaces, each with an orchestrator and a worker, whose questions both start at WQ1. */
const inTwoWorkspaces = <A, E>(
  body: (
    a: Effect.Success<ReturnType<typeof withWorker>>,
    b: Effect.Success<ReturnType<typeof otherWorkspace>>,
  ) => Effect.Effect<A, E, Server | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    const other = yield* makeWorld;
    return yield* withServer(
      world,
      Effect.gen(function* () {
        const a = yield* withWorker(world);
        const b = yield* otherWorkspace(other);
        return yield* body(a, b);
      }),
    );
  });

/**
 * Replaces the runtime's `sendNotice` for worker question notices: counts each one sent, and can
 * hang inside it, before or after the notice is handed over, so a test can cut the call off there.
 */
const stubDelivery = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const original = runtimes.sendNotice;
  const control = {
    entered: yield* Deferred.make<void>(),
    hang: false,
    hangAfterSend: false,
    sent: 0,
  };
  const mutable = runtimes as { -readonly [K in keyof typeof runtimes]: (typeof runtimes)[K] };
  mutable.sendNotice = (threadId, key, input) => {
    if (!key.startsWith("question:")) return original(threadId, key, input);
    if (control.hang) {
      return Deferred.succeed(control.entered, undefined).pipe(Effect.andThen(Effect.never));
    }
    return original(threadId, key, input).pipe(
      Effect.tap(() => {
        control.sent++;
        return control.hangAfterSend
          ? Deferred.succeed(control.entered, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void;
      }),
    );
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      mutable.sendNotice = original;
    }),
  );
  return control;
});

/** The notices telling a worker the user answered its WQ1: queued, or in its transcript. */
const answerNotices = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const queued = (yield* store.listQueue(threadId)).map((item) => item.input.text);
    const recorded = (yield* store.listMessages(threadId)).flatMap((message) =>
      message.role === "user"
        ? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : [],
    );
    return [...queued, ...recorded].filter((text) =>
      text.includes("The user answered your question WQ1"),
    );
  });

describe.skipIf(!hasGit)("worker questions", () => {
  it.effect("a worker asks, the orchestrator triages it, and answers what the brief settles", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const { session, thread, workspaceId, worker } = yield* withWorker(world);

        const result = yield* asked(worker.session);
        expect(result).toMatchObject({ asked: true, id: "WQ1", stage: "triage" });
        yield* settle;

        // The worker stands on a question, and the ledger carries it in the worker's own words.
        const ledger = yield* orchestration.ledger(workspaceId);
        const row = ledger.features[0]!.workers[0]!;
        expect(row.state).toBe("question");
        expect(ledger.questions).toEqual([
          expect.objectContaining({
            id: "WQ1",
            threadId: worker.thread.id,
            feature: "cart",
            title: "Cart API",
            question: QUESTION.question,
            context: QUESTION.context,
            options: QUESTION.options,
            recommended: "410",
            stage: "triage",
          }),
        ]);

        // Its digest carries the triage step, the rule and the worker's words as data.
        const digest = yield* nextDigest(session);
        expect(digest).toContain("Worker questions to triage (1).");
        expect(digest).toContain("`answer_worker` (`questionId`, `answer`, `source`)");
        expect(digest).toContain("`forward_question` (`questionId`)");
        expect(digest).toMatch(
          /<worker-question id="WQ1" thread="[^"]+" feature="cart" title="Cart API" forwards="[^"]+Z">/,
        );
        expect(digest).toContain(
          "options (pick one): 404 — What the API does today; 410 — Gone, so clients drop it (worker recommends)",
        );
        yield* completeTurn(session);

        // Without a source there is nothing that settles it.
        const unsourced = yield* session
          .callTool("answer_worker", { questionId: "WQ1", answer: "410" })
          .pipe(Effect.flip);
        expect(unsourced.message).toContain("Say what settles it in `source`");

        const answered = yield* session.callTool("answer_worker", {
          questionId: "wq1",
          answer: "410",
          source: "the brief: deleted carts are gone for good",
        });
        // The worker is mid-turn on its brief, so the answer is steered in.
        expect(answered).toEqual({
          questionId: "WQ1",
          threadId: worker.thread.id,
          answered: true,
          delivered: "steered",
        });
        expect(worker.session.steered.at(-1)?.text).toContain(
          "Your orchestrator answered your question WQ1 (“Should a deleted cart answer 404 or 410?”), settled by the brief: deleted carts are gone for good: 410",
        );
        yield* settle;

        const record = yield* stored(workspaceId, "WQ1");
        expect(record).toMatchObject({
          stage: "answered",
          answer: "410",
          closedBy: "orchestrator",
          source: "the brief: deleted carts are gone for good",
          delivered: "steered",
        });
        expect(record?.copyOwed).toBeUndefined();
        // The worker's card is the one card, moved on; the orchestrator's transcript shows its answer.
        const cards = yield* questionCards(worker.thread.id);
        expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject({ stage: "answered", closedBy: "orchestrator" });
        expect(yield* questionCards(thread.id)).toEqual([
          expect.objectContaining({ id: "WQ1", stage: "answered", source: record?.source }),
        ]);
        expect((yield* orchestration.ledger(workspaceId)).features[0]!.workers[0]!.state).not.toBe(
          "question",
        );

        // Closed is closed, for the orchestrator and the user alike.
        const again = yield* session
          .callTool("answer_worker", { questionId: "WQ1", answer: "404", source: "memory" })
          .pipe(Effect.flip);
        expect(again.message).toMatch(/^closed: WQ1 is answered already by the orchestrator\./);
        const late = yield* orchestration
          .answerQuestionAsUser({ workspaceId, questionId: "WQ1", answer: "404" })
          .pipe(Effect.flip);
        expect(late).toMatchObject({ _tag: "InvalidState" });
      }),
    ),
  );

  it.effect("forwards to the user with one line of context, or with none", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const { session, thread, workspaceId, worker } = yield* withWorker(world);
        yield* asked(worker.session);
        yield* asked(worker.session, { question: "Keep the old cart route?" });
        yield* settle;

        const twoLines = yield* session
          .callTool("forward_question", {
            questionId: "WQ1",
            context: "I'd pick 410.\nAlso ask about caching.",
          })
          .pipe(Effect.flip);
        expect(twoLines.message).toContain("Give at most one line of context");
        const long = yield* session
          .callTool("forward_question", { questionId: "WQ1", context: "x".repeat(201) })
          .pipe(Effect.flip);
        expect(long.message).toBe(
          "Invalid input: context: limit 200 characters; actual length 201",
        );

        expect(
          yield* session.callTool("forward_question", {
            questionId: "WQ1",
            context: "I'd pick 410; it affects Cart client too.",
          }),
        ).toEqual({ questionId: "WQ1", threadId: worker.thread.id, forwarded: true });
        expect(yield* session.callTool("forward_question", { questionId: "WQ2" })).toMatchObject({
          forwarded: true,
        });
        yield* settle;

        const first = yield* stored(workspaceId, "WQ1");
        expect(first).toMatchObject({
          stage: "forwarded",
          forwardedBy: "orchestrator",
          note: "I'd pick 410; it affects Cart client too.",
          // The worker's words go as they were written.
          question: QUESTION.question,
        });
        expect(first?.forwardedAt).toBeTypeOf("number");
        const second = yield* stored(workspaceId, "WQ2");
        expect(second).toMatchObject({ stage: "forwarded", forwardedBy: "orchestrator" });
        expect(second?.note).toBeUndefined();

        // Forwarded is the user's: the orchestrator can neither answer nor forward it again.
        const answer = yield* session
          .callTool("answer_worker", { questionId: "WQ1", answer: "410", source: "memory" })
          .pipe(Effect.flip);
        expect(answer.message).toMatch(/^forwarded: WQ1 has been forwarded to the user/);
        const twice = yield* session
          .callTool("forward_question", { questionId: "WQ1" })
          .pipe(Effect.flip);
        expect(twice.message).toMatch(/^forwarded: WQ1 is with the user already\./);

        // No longer in triage, so the digest has nothing to triage.
        const digest = yield* nextDigest(session);
        expect(digest).not.toContain("Worker questions to triage");
        yield* completeTurn(session);
        expect(yield* questionCards(thread.id)).toEqual([
          expect.objectContaining({ id: "WQ1", stage: "forwarded" }),
          expect.objectContaining({ id: "WQ2", stage: "forwarded" }),
        ]);
        expect((yield* orchestration.ledger(workspaceId)).questions?.map((q) => q.stage)).toEqual([
          "forwarded",
          "forwarded",
        ]);
      }),
    ),
  );

  it.effect("forwards itself after ten minutes in triage, and at once while paused", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const { workspaceId, worker } = yield* withWorker(world);
        yield* asked(worker.session);
        yield* settle;
        yield* TestClock.adjust("9 minutes");
        yield* settle;
        expect((yield* stored(workspaceId, "WQ1"))?.stage).toBe("triage");
        yield* TestClock.adjust("1 minute");
        yield* settle;
        const timedOut = yield* stored(workspaceId, "WQ1");
        expect(timedOut).toMatchObject({ stage: "forwarded", forwardedBy: "timeout" });
        expect(timedOut?.note).toBeUndefined();
        expect((yield* questionCards(worker.thread.id)).at(-1)).toMatchObject({
          stage: "forwarded",
          forwardedBy: "timeout",
        });

        // Nobody triages in a paused workspace: the question is the user's from the start.
        yield* orchestration.setPaused(workspaceId, true);
        expect(yield* asked(worker.session, { question: "Rename the table?" })).toMatchObject({
          id: "WQ2",
          stage: "forwarded",
        });
        expect(yield* stored(workspaceId, "WQ2")).toMatchObject({
          stage: "forwarded",
          forwardedBy: "paused",
        });
      }),
    ),
  );

  it.effect(
    "a restart arms triage again: one that ran out meanwhile goes to the user at once",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const workspaceId = yield* withServer(
          world,
          Effect.gen(function* () {
            const opened = yield* withWorker(world);
            yield* asked(opened.worker.session);
            yield* settle;
            return opened.workspaceId;
          }),
        );
        // The app was down past the question's ten minutes.
        yield* TestClock.adjust("11 minutes");
        yield* withServer(
          world,
          Effect.gen(function* () {
            const moved = yield* waitReal(
              "the overdue question to be forwarded",
              Effect.map(stored(workspaceId, "WQ1"), (question) =>
                question?.stage === "forwarded" ? question : undefined,
              ),
            );
            expect(moved).toMatchObject({ forwardedBy: "timeout" });
          }),
        );
      }),
  );

  it.effect("another workspace's question with the same id doesn't replace a triage timer", () =>
    inTwoWorkspaces((a, b) =>
      Effect.gen(function* () {
        // Each asks its first question, WQ1, a minute apart.
        yield* asked(a.worker.session);
        yield* settle;
        yield* TestClock.adjust("1 minute");
        yield* asked(b.worker.session);
        yield* settle;
        yield* TestClock.adjust("9 minutes");
        yield* settle;
        expect(yield* stored(a.workspaceId, "WQ1")).toMatchObject({
          stage: "forwarded",
          forwardedBy: "timeout",
        });
        expect((yield* stored(b.workspaceId, "WQ1"))?.stage).toBe("triage");
        yield* TestClock.adjust("1 minute");
        yield* settle;
        expect(yield* stored(b.workspaceId, "WQ1")).toMatchObject({
          stage: "forwarded",
          forwardedBy: "timeout",
        });
      }),
    ),
  );

  it.effect("forwarding a question cancels no other workspace's timer with the same id", () =>
    inTwoWorkspaces((a, b) =>
      Effect.gen(function* () {
        // B's is asked first, so A's timer is the newer one under a shared key.
        yield* asked(b.worker.session);
        yield* settle;
        yield* asked(a.worker.session);
        yield* settle;
        yield* b.session.callTool("forward_question", { questionId: "WQ1" });
        expect(yield* stored(b.workspaceId, "WQ1")).toMatchObject({
          forwardedBy: "orchestrator",
        });
        yield* TestClock.adjust("10 minutes");
        yield* settle;
        expect(yield* stored(a.workspaceId, "WQ1")).toMatchObject({
          stage: "forwarded",
          forwardedBy: "timeout",
        });
      }),
    ),
  );

  it.effect("the user's answer goes straight to the worker: steered mid-turn, sent when idle", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const store = yield* ThreadStore;
        const { session, workspaceId, worker } = yield* withWorker(world);
        yield* asked(worker.session);
        yield* session.callTool("forward_question", { questionId: "WQ1" });
        yield* settle;

        // Mid-turn: steered at the next tool boundary.
        const running = yield* orchestration.answerQuestionAsUser({
          workspaceId,
          questionId: "WQ1",
          answer: "410, and log it",
        });
        expect(running).toMatchObject({
          stage: "answered",
          closedBy: "user",
          answer: "410, and log it",
          delivered: "steered",
        });
        expect(worker.session.steered.at(-1)?.text).toContain(
          "The user answered your question WQ1 (“Should a deleted cart answer 404 or 410?”): 410, and log it",
        );
        expect(worker.session.steered.at(-1)?.text).toContain("Your orchestrator has a copy.");
        yield* settle;
        // An answer isn't the user typing into the worker: it stays the orchestrator's.
        expect((yield* outboxOf(workspaceId)).workers[worker.thread.id]?.userIntervened).toBe(
          false,
        );

        // Idle: it starts the worker's next turn.
        yield* completeTurn(worker.session);
        yield* asked(worker.session, { question: "Keep the old cart route?" });
        yield* settle;
        const sentBefore = worker.session.sent.length;
        const idle = yield* orchestration.answerQuestionAsUser({
          workspaceId,
          questionId: "WQ2",
          answer: "No",
        });
        expect(idle.delivered).toBe("sent");
        const woken = yield* waitSent(worker.thread.id, sentBefore + 1);
        expect(woken.sent.at(-1)?.text).toContain("The user answered your question WQ2");
        expect(woken.sent.at(-1)?.origin).toBeUndefined();
        // History: who answered and when, on the worker's own card.
        const cards = yield* questionCards(worker.thread.id);
        expect(cards.map((card) => [card.id, card.stage, card.closedBy])).toEqual([
          ["WQ1", "answered", "user"],
          ["WQ2", "answered", "user"],
        ]);
        expect(cards[1]?.closedAt).toBeTypeOf("number");
        expect((yield* store.getThread(worker.thread.id)).id).toBe(worker.thread.id);
      }),
    ),
  );

  it.effect("durably dismisses a forwarded archived worker question without waking it", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const saved = yield* withServer(
        world,
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const runtimes = yield* ThreadRuntimes;
          const { session, workspaceId, worker } = yield* withWorker(world);
          yield* asked(worker.session);
          yield* session.callTool("forward_question", { questionId: "WQ1" });
          yield* completeTurn(worker.session);
          yield* runtimes.updateThread(worker.thread.id, (thread) => ({ ...thread, parked: true }));
          const sent = worker.session.sent.length;
          const steered = worker.session.steered.length;
          const dismissed = yield* orchestration.dismissQuestionAsUser({
            workspaceId,
            questionId: "WQ1",
            reason: "Already decided in the conversation",
          });
          expect(dismissed).toMatchObject({ stage: "dismissed", closedBy: "user" });
          expect(dismissed.delivered).toBeUndefined();
          expect(worker.session.sent).toHaveLength(sent);
          expect(worker.session.steered).toHaveLength(steered);
          expect(
            (yield* orchestration.ledger(workspaceId)).questions?.filter(
              (q) => q.stage === "forwarded",
            ),
          ).toEqual([]);
          expect((yield* questionCards(worker.thread.id)).at(-1)?.stage).toBe("dismissed");
          const results = yield* Effect.all(
            [
              orchestration.dismissQuestionAsUser({ workspaceId, questionId: "wq1" }),
              orchestration.answerQuestionAsUser({
                workspaceId,
                questionId: "WQ1",
                answer: "Late answer",
              }),
            ],
            { concurrency: "unbounded" },
          );
          expect(results.every((q) => q.stage === "dismissed")).toBe(true);
          expect((yield* stored(workspaceId, "WQ1"))?.answer).toBeUndefined();
          return { workspaceId, threadId: worker.thread.id };
        }),
      );
      yield* TestClock.adjust("11 minutes");
      yield* withServer(
        world,
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const store = yield* ThreadStore;
          yield* settle;
          expect((yield* stored(saved.workspaceId, "WQ1"))?.stage).toBe("dismissed");
          expect(
            (yield* orchestration.ledger(saved.workspaceId)).questions?.filter(
              (q) => q.stage === "forwarded",
            ),
          ).toEqual([]);
          expect((yield* store.getThread(saved.threadId)).parked).toBe(true);
        }),
      );
    }),
  );

  it.effect(
    "concurrent user answer and dismissal keep the first decision and notify only once",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { session, workspaceId, worker, project } = yield* withWorker(world);
          yield* asked(worker.session);
          yield* asked(worker.session, { question: "A separate unresolved decision?" });
          yield* session.callTool("forward_question", { questionId: "WQ1" });
          const other = yield* orchestration.saveWorkspace({
            name: "Other",
            projectIds: [project.id],
            homeProjectId: project.id,
          });
          const wrongWorkspace = yield* orchestration
            .dismissQuestionAsUser({ workspaceId: other.workspace.id, questionId: "WQ1" })
            .pipe(Effect.flip);
          expect(wrongWorkspace).toMatchObject({ _tag: "NotFound" });
          expect((yield* stored(workspaceId, "WQ1"))?.stage).toBe("forwarded");
          const before = worker.session.steered.length;
          const results = yield* Effect.all(
            [
              orchestration.answerQuestionAsUser({ workspaceId, questionId: "WQ1", answer: "410" }),
              orchestration.dismissQuestionAsUser({
                workspaceId,
                questionId: "WQ1",
                reason: "Late dismissal",
              }),
            ],
            { concurrency: "unbounded" },
          );
          const winner = yield* stored(workspaceId, "WQ1");
          expect(["answered", "dismissed"]).toContain(winner?.stage);
          for (const result of results) {
            expect(result.stage).toBe(winner?.stage);
            expect(result.answer).toBe(winner?.answer);
            expect(result.reason).toBe(winner?.reason);
            expect(result.closedAt).toBe(winner?.closedAt);
          }
          expect(worker.session.steered).toHaveLength(before + 1);
          expect((yield* stored(workspaceId, "WQ2"))?.stage).toBe("triage");
          const forwardAgain = yield* session
            .callTool("forward_question", { questionId: "WQ1" })
            .pipe(Effect.flip);
          expect(forwardAgain.message).toMatch(/^closed:/);
        }),
      ),
  );

  it.effect("a retry delivers the answer whose first delivery was interrupted, once", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { worker, workspaceId } = yield* withWorker(world);
        yield* asked(worker.session);
        const orchestration = yield* Orchestration;
        const delivery = yield* stubDelivery;
        // The decision is written, then the call is cut off inside the worker's notice.
        delivery.hang = true;
        const call = yield* orchestration
          .answerQuestionAsUser({ workspaceId, questionId: "WQ1", answer: "410" })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(delivery.entered);
        yield* Fiber.interrupt(call);
        delivery.hang = false;
        expect(yield* stored(workspaceId, "WQ1")).toMatchObject({
          stage: "answered",
          answer: "410",
          deliveryOwed: true,
        });

        // The user's retry, even with other words, keeps the decision and sends what is owed.
        const retried = yield* orchestration.answerQuestionAsUser({
          workspaceId,
          questionId: "WQ1",
          answer: "404",
        });
        expect(retried).toMatchObject({ stage: "answered", answer: "410" });
        expect(retried.delivered).toBeDefined();
        expect(delivery.sent).toBe(1);
        expect((yield* stored(workspaceId, "WQ1"))?.deliveryOwed).toBeUndefined();
        expect(
          [...worker.session.sent, ...worker.session.steered].filter((input) =>
            input.text.includes("The user answered your question WQ1"),
          ),
        ).toHaveLength(1);

        // Settled, a further retry sends nothing.
        yield* orchestration.answerQuestionAsUser({
          workspaceId,
          questionId: "WQ1",
          answer: "410",
        });
        expect(delivery.sent).toBe(1);
      }),
    ),
  );

  it.effect("a restart delivers an answer a crash cut off, and never twice", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const saved = yield* withServer(
        world,
        Effect.gen(function* () {
          const { worker, workspaceId } = yield* withWorker(world);
          yield* asked(worker.session);
          const delivery = yield* stubDelivery;
          delivery.hang = true;
          yield* (yield* Orchestration)
            .answerQuestionAsUser({ workspaceId, questionId: "WQ1", answer: "410" })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(delivery.entered);
          // The server goes down here, with the answer written and its notice not handed over.
          return { workspaceId, threadId: worker.thread.id };
        }),
      );
      yield* withServer(
        world,
        Effect.gen(function* () {
          const settled = yield* waitReal(
            "the owed answer delivered after the restart",
            Effect.map(stored(saved.workspaceId, "WQ1"), (question) =>
              question?.deliveryOwed === undefined ? question : undefined,
            ),
          );
          expect(settled).toMatchObject({ stage: "answered", answer: "410" });
          expect(settled?.delivered).toBeDefined();
          expect(yield* answerNotices(saved.threadId)).toHaveLength(1);
        }),
      );
      // Another restart finds nothing owed and sends nothing more.
      yield* withServer(
        world,
        Effect.gen(function* () {
          yield* settle;
          expect(yield* answerNotices(saved.threadId)).toHaveLength(1);
        }),
      );
    }),
  );

  it.effect("an owed answer to a worker archived meanwhile is settled at restart, unsent", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const saved = yield* withServer(
        world,
        Effect.gen(function* () {
          const { worker, workspaceId } = yield* withWorker(world);
          yield* asked(worker.session);
          const delivery = yield* stubDelivery;
          delivery.hang = true;
          yield* (yield* Orchestration)
            .answerQuestionAsUser({ workspaceId, questionId: "WQ1", answer: "410" })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(delivery.entered);
          yield* (yield* ThreadRuntimes).updateThread(worker.thread.id, (thread) => ({
            ...thread,
            parked: true,
          }));
          return { workspaceId, threadId: worker.thread.id };
        }),
      );
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const settled = yield* waitReal(
            "the owed answer settled after the restart",
            Effect.map(stored(saved.workspaceId, "WQ1"), (question) =>
              question?.deliveryOwed === undefined ? question : undefined,
            ),
          );
          expect(settled).toMatchObject({ stage: "answered", answer: "410" });
          expect(settled?.delivered).toBeUndefined();
          expect(yield* store.listQueue(saved.threadId)).toEqual([]);
          expect((yield* store.getThread(saved.threadId)).parked).toBe(true);
        }),
      );
    }),
  );

  it.effect("a retry doesn't send again a notice the interrupted call already handed over", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { worker, workspaceId } = yield* withWorker(world);
        yield* asked(worker.session);
        const orchestration = yield* Orchestration;
        const delivery = yield* stubDelivery;
        // The notice is handed over, then the call is cut off before that is written down.
        delivery.hangAfterSend = true;
        const call = yield* orchestration
          .answerQuestionAsUser({ workspaceId, questionId: "WQ1", answer: "410" })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(delivery.entered);
        yield* Fiber.interrupt(call);
        delivery.hangAfterSend = false;
        expect(delivery.sent).toBe(1);
        expect((yield* stored(workspaceId, "WQ1"))?.deliveryOwed).toBe(true);

        const retried = yield* orchestration.answerQuestionAsUser({
          workspaceId,
          questionId: "WQ1",
          answer: "410",
        });
        expect(retried.delivered).toBeDefined();
        expect(delivery.sent).toBe(1);
        expect((yield* stored(workspaceId, "WQ1"))?.deliveryOwed).toBeUndefined();
      }),
    ),
  );

  it.effect("the user dismisses a question, with a reason; the worker is told", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const { workspaceId, worker } = yield* withWorker(world);
        yield* asked(worker.session);
        yield* settle;
        // The user's word outranks the orchestrator's: one still in triage can be dismissed too.
        const dismissed = yield* orchestration.dismissQuestionAsUser({
          workspaceId,
          questionId: "WQ1",
          reason: "Out of scope for this PR",
        });
        expect(dismissed).toMatchObject({
          stage: "dismissed",
          closedBy: "user",
          reason: "Out of scope for this PR",
          delivered: "steered",
        });
        expect(dismissed.answer).toBeUndefined();
        const told = worker.session.steered.at(-1)?.text ?? "";
        expect(told).toContain("The user dismissed your question WQ1");
        expect(told).toContain("Their reason: Out of scope for this PR");
        expect(told).toContain("Don't wait for an answer");

        // Without a reason it says none.
        yield* asked(worker.session, { question: "Rename the table?" });
        const bare = yield* orchestration.dismissQuestionAsUser({ workspaceId, questionId: "WQ2" });
        expect(bare.reason).toBeUndefined();
        expect(worker.session.steered.at(-1)?.text).not.toContain("Their reason");
        // The triage timer went with it.
        yield* TestClock.adjust("15 minutes");
        yield* settle;
        expect((yield* stored(workspaceId, "WQ1"))?.stage).toBe("dismissed");
      }),
    ),
  );

  it.effect(
    "the orchestrator gets a copy of what the user closed, once, to record and pass on",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { session, workspaceId, worker } = yield* withWorker(world);
          yield* asked(worker.session);
          yield* asked(worker.session, { question: "Rename the table?" });
          yield* session.callTool("forward_question", { questionId: "WQ1" });
          yield* session.callTool("forward_question", { questionId: "WQ2" });
          yield* settle;
          yield* orchestration.answerQuestionAsUser({
            workspaceId,
            questionId: "WQ1",
            answer: "410",
          });
          yield* orchestration.dismissQuestionAsUser({
            workspaceId,
            questionId: "WQ2",
            reason: "Not now",
          });
          expect((yield* stored(workspaceId, "WQ1"))?.copyOwed).toBe(true);

          const digest = yield* nextDigest(session);
          expect(digest).toContain("Worker questions the user closed since your last digest (2).");
          expect(digest).toContain("Worker notification: steered.");
          expect(digest).toContain("Record each decision (in memory, or in the standing decisions");
          expect(digest).toContain("pass it on to any other worker it affects");
          expect(digest).toMatch(/<worker-question id="WQ1" [^>]* state="answered">/);
          expect(digest).toMatch(/answered by the user at [^:]+:\d\dZ: 410/);
          expect(digest).toMatch(/dismissed by the user at [^:]+:\d\dZ: Not now/);
          // Acknowledged with the turn that carried it, the copy is no longer owed.
          yield* completeTurn(session);
          expect((yield* stored(workspaceId, "WQ1"))?.copyOwed).toBeUndefined();
          expect((yield* stored(workspaceId, "WQ2"))?.copyOwed).toBeUndefined();

          // The next digest, woken by something else, doesn't tell it again.
          yield* worker.session.callTool("report", { state: "progress", summary: "Halfway." });
          const later = yield* nextDigest(session);
          expect(later).not.toContain("closed since your last digest");
          yield* completeTurn(session);
        }),
      ),
  );

  it.effect("refuses those a question isn't theirs to answer", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const { session, workspaceId, worker } = yield* withWorker(world);
        const sibling = yield* spawn(session, { feature: "cart-client", title: "Cart client" });
        yield* completeTurn(session);
        yield* asked(worker.session);
        yield* settle;

        // No worker has a tool to answer or forward a question, its own or another's.
        for (const name of ["answer_worker", "forward_question"]) {
          for (const asker of [worker.session, sibling.session]) {
            const refused = yield* asker
              .callTool(name, { questionId: "WQ1", answer: "410", source: "me" })
              .pipe(Effect.flip);
            expect(refused.message).toBe(`unknown tool ${name}`);
          }
        }
        // And the service refuses one that gets there anyway.
        const byWorker = yield* orchestration
          .answerWorkerQuestion(sibling.thread.id, {
            questionId: "WQ1",
            answer: "410",
            source: "me",
          })
          .pipe(Effect.flip);
        expect(byWorker.message).toMatch(/^no_authority: /);
        const forwardByWorker = yield* orchestration
          .forwardQuestion(worker.thread.id, { questionId: "WQ1" })
          .pipe(Effect.flip);
        expect(forwardByWorker.message).toMatch(/^no_authority: /);

        // Unknown ids say so, to the orchestrator and to the user.
        const unknown = yield* session
          .callTool("forward_question", { questionId: "WQ9" })
          .pipe(Effect.flip);
        expect(unknown.message).toMatch(/^unknown_question: There is no question WQ9/);
        const userUnknown = yield* orchestration
          .answerQuestionAsUser({ workspaceId, questionId: "WQ9", answer: "x" })
          .pipe(Effect.flip);
        expect(userUnknown).toMatchObject({ _tag: "NotFound", entity: "question", id: "WQ9" });

        // Paused: the orchestrator answers nothing for the user.
        yield* orchestration.setPaused(workspaceId, true);
        const paused = yield* session
          .callTool("answer_worker", { questionId: "WQ1", answer: "410", source: "memory" })
          .pipe(Effect.flip);
        expect(paused.message).toMatch(/^paused: /);
        yield* orchestration.setPaused(workspaceId, false);
        yield* settle;

        // A thread that is no longer its worker asked it: not the orchestrator's to answer.
        yield* orchestration.detach(worker.thread.id);
        yield* settle;
        const detached = yield* session
          .callTool("answer_worker", { questionId: "WQ1", answer: "410", source: "memory" })
          .pipe(Effect.flip);
        expect(detached.message).toMatch(/^not_your_worker: /);
        const forwardDetached = yield* session
          .callTool("forward_question", { questionId: "WQ1" })
          .pipe(Effect.flip);
        expect(forwardDetached.message).toMatch(/^not_your_worker: /);

        // A worker's question must be one the board can show.
        const tooMany = yield* sibling.session
          .callTool("ask_question", {
            question: "Which?",
            options: [{ label: "a" }],
          })
          .pipe(Effect.flip);
        expect(tooMany.message).toContain("Offer 2 to 4 options");
        const offList = yield* sibling.session
          .callTool("ask_question", {
            question: "Which?",
            options: [{ label: "a" }, { label: "b" }],
            recommended: "c",
          })
          .pipe(Effect.flip);
        expect(offList.message).toContain("`recommended` has to be one of their labels");
        const ledger: OrchestratorLedger = yield* orchestration.ledger(workspaceId);
        expect(ledger.questions?.map((question) => question.id)).toEqual(["WQ1"]);
      }),
    ),
  );

  it.effect(
    "carries each option's screenshot and the mock from the worker's worktree, nothing outside",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { workspaceId, worker } = yield* withWorker(world);
          const store = yield* ThreadStore;
          const root = (yield* store.getThread(worker.thread.id)).checkout.path;
          const mock = nodePath.join(root, "docs/design/mocks/needs-you-home");
          fs.mkdirSync(nodePath.join(mock, "shots"), { recursive: true });
          fs.writeFileSync(nodePath.join(mock, "mock.json"), "{}");
          fs.writeFileSync(nodePath.join(mock, "v1.html"), "<!doctype html>");
          fs.writeFileSync(nodePath.join(mock, "shots", "c-popover-dark.png"), "png");

          const result = yield* asked(worker.session, {
            question: "Which direction should I build?",
            options: [
              { label: "B Jump" },
              {
                label: "C Hybrid",
                image: "docs/design/mocks/needs-you-home/shots/c-popover-dark.png",
                preview: "docs/design/mocks/needs-you-home/v1.html#c-hybrid-popover",
              },
            ],
            recommended: "C Hybrid",
            mock: "docs/design/mocks/needs-you-home/mock.json",
          });
          expect(result).toMatchObject({ asked: true, id: "WQ1" });
          const ledger = yield* orchestration.ledger(workspaceId);
          expect(ledger.questions?.[0]).toMatchObject({
            options: [
              { label: "B Jump" },
              {
                label: "C Hybrid",
                image: nodePath.join(mock, "shots", "c-popover-dark.png"),
                preview: `${nodePath.join(mock, "v1.html")}#c-hybrid-popover`,
              },
            ],
            mock: nodePath.join(mock, "mock.json"),
          });

          // A picture outside the worktree refuses the question, and none is kept.
          const outside = nodePath.join(world.dir, "elsewhere.png");
          fs.writeFileSync(outside, "png");
          const refused = yield* worker.session
            .callTool("ask_question", {
              question: "And this one?",
              options: [{ label: "A", image: outside }, { label: "B" }],
            })
            .pipe(Effect.flip);
          expect(refused.message).toContain("elsewhere.png is outside this thread's folders");
          expect((yield* orchestration.ledger(workspaceId)).questions).toHaveLength(1);
        }),
      ),
  );
});
