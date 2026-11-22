import { describe, expect, it } from "@effect/vitest";
import { questionStatusLine } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { hasGit } from "../git/test-repo.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Orchestration } from "./service.ts";
import { completeTurn, settle } from "./test-harness.ts";
import { asked, inServer, nextDigest, stored, withWorker } from "./worker-question-harness.ts";

// Changing an answer a worker's question already has: the user's from its card or in a message
// an agent records, the orchestrator's own with answer_worker. The worker gets the new answer as a
// new message, and a change made against an answer that has moved on since is refused.

describe.skipIf(!hasGit)("worker question answers changed", () => {
  it.effect(
    "the user changes an answer: the worker gets it as a new message; a stale change is refused",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { session, workspaceId, worker } = yield* withWorker(world);
          yield* asked(worker.session);
          yield* session.callTool("forward_question", { questionId: "WQ1" });
          yield* orchestration.answerQuestionAsUser({
            workspaceId,
            questionId: "WQ1",
            answer: "404",
          });
          yield* settle;
          const first = (yield* stored(workspaceId, "WQ1"))?.closedAt;
          expect(first).toBeTypeOf("number");
          const toWorker = () =>
            [...worker.session.sent, ...worker.session.steered].map((input) => input.text);
          const told = toWorker().length;
          // The orchestrator has its copy of the first answer.
          expect(yield* nextDigest(session)).toContain("answered by the user at");
          yield* completeTurn(session);

          const changed = yield* orchestration.answerQuestionAsUser({
            workspaceId,
            questionId: "WQ1",
            answer: "410",
            replaces: { closedAt: first! },
          });
          expect(changed).toMatchObject({
            stage: "answered",
            closedBy: "user",
            answer: "410",
            revised: true,
          });
          expect(changed.closedAt).toBeGreaterThan(first!);
          expect(questionStatusLine(changed)).toMatch(/^Answer changed by you · \d\d:\d\d$/);
          yield* settle;
          const after = toWorker();
          expect(after).toHaveLength(told + 1);
          expect(after.at(-1)).toContain("The user changed their answer to your question WQ1");
          expect(after.at(-1)).toContain(": 410");

          // A card that still shows the first answer can't overwrite the newer one.
          const stale = yield* orchestration
            .answerQuestionAsUser({
              workspaceId,
              questionId: "WQ1",
              answer: "404",
              replaces: { closedAt: first! },
            })
            .pipe(Effect.flip);
          expect(stale._tag).toBe("InvalidState");
          expect(stale.message).toContain("it is now “410”");
          // Nor can one that answers it as if it were open.
          yield* orchestration.answerQuestionAsUser({
            workspaceId,
            questionId: "WQ1",
            answer: "404",
          });
          yield* settle;
          expect(yield* stored(workspaceId, "WQ1")).toMatchObject({ answer: "410", revised: true });
          expect(toWorker()).toHaveLength(told + 1);

          const digest = yield* nextDigest(session);
          expect(digest).toContain("answer changed by the user");
          expect(digest).toContain("410");
        }),
      ),
  );

  it.effect("the orchestrator changes its own answer with answer_worker, never the user's", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const { session, workspaceId, worker } = yield* withWorker(world);
        yield* asked(worker.session);
        yield* session.callTool("answer_worker", {
          questionId: "WQ1",
          answer: "404",
          source: "the brief",
        });
        const toWorker = () =>
          [...worker.session.sent, ...worker.session.steered].map((input) => input.text);
        const told = toWorker().length;
        yield* TestClock.adjust("1 minute");
        yield* session.callTool("answer_worker", {
          questionId: "WQ1",
          answer: "410",
          source: "decisions.md",
        });
        expect(yield* stored(workspaceId, "WQ1")).toMatchObject({
          answer: "410",
          source: "decisions.md",
          closedBy: "orchestrator",
          revised: true,
        });
        expect(toWorker()).toHaveLength(told + 1);
        expect(toWorker().at(-1)).toContain(
          "Your orchestrator changed its answer to your question WQ1",
        );
        // The same answer again changes nothing and sends nothing.
        yield* session.callTool("answer_worker", {
          questionId: "WQ1",
          answer: "410",
          source: "decisions.md",
        });
        expect(toWorker()).toHaveLength(told + 1);

        // An answer the user gave is theirs.
        yield* asked(worker.session, { question: "Keep the old cart route?" });
        yield* session.callTool("forward_question", { questionId: "WQ2" });
        yield* orchestration.answerQuestionAsUser({ workspaceId, questionId: "WQ2", answer: "No" });
        const refused = yield* session
          .callTool("answer_worker", { questionId: "WQ2", answer: "Yes", source: "the brief" })
          .pipe(Effect.flip);
        expect(String((refused as { message?: string }).message)).toContain(
          "only they can change its answer",
        );
        expect(yield* stored(workspaceId, "WQ2")).toMatchObject({ answer: "No", closedBy: "user" });
      }),
    ),
  );

  it.effect(
    "the orchestrator records the user's changed answer from a message written after it",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { session, workspaceId, worker, thread } = yield* withWorker(world);
          yield* asked(worker.session);
          yield* session.callTool("forward_question", { questionId: "WQ1" });
          yield* orchestration.answerQuestionAsUser({
            workspaceId,
            questionId: "WQ1",
            answer: "404",
          });
          yield* settle;
          // Nothing the user wrote since it was answered: nothing to change it to.
          const none = yield* session
            .callTool("record_user_answer", { questionId: "WQ1" })
            .pipe(Effect.flip);
          expect(String((none as { message?: string }).message)).toContain(
            "WQ1 is answered already, and the user hasn't written in your thread since",
          );
          yield* nextDigest(session);
          yield* completeTurn(session);
          yield* (yield* ThreadRuntimes).send(thread.id, { text: "make it 410 after all" });
          yield* settle;
          yield* session.callTool("record_user_answer", { questionId: "WQ1" });
          yield* settle;
          expect(yield* stored(workspaceId, "WQ1")).toMatchObject({
            stage: "answered",
            closedBy: "user",
            recordedBy: "orchestrator",
            answer: "make it 410 after all",
            revised: true,
          });
          expect([...worker.session.sent, ...worker.session.steered].at(-1)?.text ?? "").toContain(
            "changed their answer to your question WQ1 (“Should a deleted cart answer 404 or 410?”) in a message to your orchestrator, copied here word for word: make it 410 after all",
          );
        }),
      ),
  );
});
