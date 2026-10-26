// Dream merges that fail or go stale, memory edits through the same door, and answers.
import { describe, expect, it } from "@effect/vitest";
import {
  askQuestion,
  parseQuestions,
  type MessageId,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { dreamHandlers, isQueuedAnswer, makeAnswerOnce } from "./dream-handler.ts";
import { Dreams } from "./dreams.ts";
import { OrchestrationMemory } from "./memory.ts";
import { Orchestration } from "./service.ts";
import {
  collectEvents,
  completeTurn,
  openOrchestrator,
  waitStatus,
  type World,
} from "./test-harness.ts";
import {
  githubToken,
  memoryRoot,
  inDreams,
  waitDream,
  writeOutput,
  startDream,
  finishDream,
  waitMergeSession,
  waitMerged,
  ANSWERED_FILE,
  ANSWER_TO,
  flaky,
} from "./dreams-service-kit.ts";

/** A finished dream whose goals.md conflicts with a live write made while it ran. */
const conflictedDream = (world: World) =>
  Effect.gen(function* () {
    const memory = yield* OrchestrationMemory;
    const { workspaceId } = yield* openOrchestrator(world);
    yield* memory.write(workspaceId, "goals.md", "a\n");
    const { dream, session } = yield* startDream(workspaceId);
    yield* memory.write(workspaceId, "goals.md", "a\nb\n");
    writeOutput(dream, { "goals.md": "A\n" });
    yield* finishDream(dream, session, "completed");
    return { dream, workspaceId };
  });

describe.skipIf(!hasGit)("dreams", () => {
  // Each way a merge can fail is its own test: run one after another on one dream they came to
  // about 25 s, close to the 30 s timeout once the Dream files run side by side.
  it.effect("a merge whose reply has no merged file, or runs past the cap, is never adopted", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const dreams = yield* Dreams;
        const { dream } = yield* conflictedDream(world);

        yield* dreams.merge(dream.id, "goals.md");
        yield* (yield* waitMergeSession(1)).completeTurn("I merged it for you.");
        expect(yield* waitMerged(dream.id, "goals.md")).toMatchObject({
          status: "failed",
          error: "The model's reply had no merged file in it.",
        });

        // Over the cap: refused whole, never cut to fit.
        yield* dreams.merge(dream.id, "goals.md");
        const second = yield* waitMergeSession(2);
        // Every run starts in a folder of its own, so nothing one left reaches the next.
        expect(second.options.cwd).not.toBe((yield* waitMergeSession(1)).options.cwd);
        yield* second.completeTurn(`<merged_file>\n${"x".repeat(33 * 1024)}\n</merged_file>`);
        const over = yield* waitMerged(dream.id, "goals.md");
        expect(over.status).toBe("failed");
        expect(over.error).toContain("past the 32.0 KB a memory file may be. Nothing was cut");
        const refused = yield* Effect.flip(
          dreams.adopt(dream.id, { resolutions: { "goals.md": "merged" } }),
        );
        expect(refused.message).toContain("no finished merge of goals.md");
      }),
    ),
  );

  it.effect("a merge reply that never ends is stopped while it streams, not read to the end", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const dreams = yield* Dreams;
        const { dream } = yield* conflictedDream(world);
        yield* dreams.merge(dream.id, "goals.md");
        const runaway = yield* waitMergeSession(1);
        for (let i = 0; i < 5; i++) {
          yield* runaway.emit({
            type: "chunk",
            messageId: "m-runaway" as MessageId,
            chunk: { type: "text-delta", id: "t", delta: "x".repeat(32 * 1024) },
          });
        }
        expect((yield* waitMerged(dream.id, "goals.md")).error).toContain(
          "reply ran past 128 K characters",
        );
      }),
    ),
  );

  it.effect("a merge the model never answers fails at its deadline", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const dreams = yield* Dreams;
        const { dream } = yield* conflictedDream(world);
        yield* dreams.merge(dream.id, "goals.md");
        yield* waitMergeSession(1);
        yield* TestClock.adjust("11 minutes");
        expect((yield* waitMerged(dream.id, "goals.md")).error).toContain("didn't answer within");
      }),
    ),
  );

  it.effect("a finished merge outrun by a live write is never adopted", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const dreams = yield* Dreams;
        const memory = yield* OrchestrationMemory;
        const { dream, workspaceId } = yield* conflictedDream(world);
        yield* dreams.merge(dream.id, "goals.md");
        yield* (yield* waitMergeSession(1)).completeTurn("<merged_file>\nA\nb\n</merged_file>");
        expect((yield* waitMerged(dream.id, "goals.md")).merged).toBe("A\nb\n");
        // A live write since makes it a merge of sides that are gone.
        yield* memory.write(workspaceId, "goals.md", "a\nb\nc\n");
        const moved = yield* dreams.review(dream.id);
        expect(moved.files.find((file) => file.path === "goals.md")?.merge).toBeUndefined();
        const stale = yield* Effect.flip(
          dreams.adopt(dream.id, { resolutions: { "goals.md": "merged" } }),
        );
        expect(stale.message).toContain("Merge it again, or choose a side");
        expect(yield* memory.read(workspaceId, "goals.md")).toBe("a\nb\nc\n");
      }),
    ),
  );

  it.effect("memory or output that moved since the review means reviewing again", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const dreams = yield* Dreams;
        const memory = yield* OrchestrationMemory;
        const { workspaceId } = yield* openOrchestrator(world);
        const { dream, session } = yield* startDream(workspaceId);
        writeOutput(dream, { "decisions.md": "2026-09-24: deploy on merge\n" });
        yield* finishDream(dream, session, "completed");
        const review = yield* dreams.review(dream.id);

        // One more turn in the dream's thread rewrote the output after the user looked.
        writeOutput(dream, { "decisions.md": "2026-09-24: deploy by hand\n" });
        const rewritten = yield* Effect.flip(
          dreams.adopt(dream.id, { outputDigest: review.outputDigest }),
        );
        expect(rewritten.message).toContain("output was changed since this review");

        // Another adoption, or a restore, moved memory on.
        yield* memory.adopt(workspaceId, [{ path: "MEMORY.md", content: "# Memory index\n" }]);
        const moved = yield* Effect.flip(dreams.adopt(dream.id, { basedOn: review.memoryVersion }));
        expect(moved.message).toContain("Review the dream again");
        expect(yield* memory.currentVersion(workspaceId)).toBe("0002");

        const again = yield* dreams.review(dream.id);
        expect(again.memoryVersion).toBe("0002");
        const adopted = yield* dreams.adopt(dream.id, {
          basedOn: again.memoryVersion,
          outputDigest: again.outputDigest,
          resolutions: Object.fromEntries(
            again.files
              .filter((file) => file.status === "conflict")
              .map((file) => [file.path, "output" as const]),
          ),
        });
        expect(adopted.adoptedVersion).toBe("0003");
        expect(yield* memory.read(workspaceId, "decisions.md")).toContain("deploy by hand");
      }),
    ),
  );

  it.effect(
    "cancel keeps the output to look at; discard takes folder, manifest, row and thread",
    () =>
      inDreams((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const dreams = yield* Dreams;
          const { workspaceId } = yield* openOrchestrator(world);
          const { dream, session } = yield* startDream(workspaceId);
          writeOutput(dream, { "decisions.md": "half a thought\n" });

          const canceled = yield* dreams.cancel(dream.id);
          expect(canceled).toMatchObject({ status: "canceled", failure: "canceled" });
          expect(session.interrupts).toBe(1);
          // The interrupted turn ending is not the dream finishing.
          yield* completeTurn(session, "done");
          expect((yield* store.getDream(dream.id)).status).toBe("canceled");
          expect((yield* dreams.review(dream.id)).files.map((file) => file.path)).toEqual([
            "MEMORY.md",
            "decisions.md",
          ]);
          expect((yield* Effect.flip(dreams.adopt(dream.id))).message).toContain("only discarded");
          expect((yield* Effect.flip(dreams.cancel(dream.id)))._tag).toBe("InvalidState");

          const manifest = nodePath.join(
            memoryRoot(world),
            workspaceId,
            "dream-manifests",
            `${dream.id}.json`,
          );
          expect(fs.existsSync(manifest)).toBe(true);
          yield* dreams.discard(dream.id);
          expect(fs.existsSync(dream.outputDir)).toBe(false);
          expect(fs.existsSync(manifest)).toBe(false);
          expect((yield* Effect.flip(store.getDream(dream.id))).entity).toBe("dream");
          expect(
            (yield* store.listThreads).some((thread) => thread.id === (dream.threadId as ThreadId)),
          ).toBe(false);

          // Closing a running dream's thread cancels it, and the row outlives the thread.
          const closed = yield* startDream(workspaceId);
          yield* (yield* ThreadRuntimes).close(closed.dream.threadId as ThreadId);
          const orphan = yield* waitDream(closed.dream.id, "canceled");
          expect("threadId" in orphan).toBe(false);
          expect(fs.existsSync(closed.dream.outputDir)).toBe(true);
        }),
      ),
  );

  it.effect("the user edits memory through the same door, paused or not", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const handlers = yield* dreamHandlers;
        const orchestration = yield* Orchestration;
        const events = yield* collectEvents(["orchestration.changed"]);
        const { workspaceId } = yield* openOrchestrator(world);
        yield* orchestration.setPaused(workspaceId, true);
        events.length = 0;

        const write = yield* handlers["memory.write"]({
          workspaceId,
          path: "goals.md",
          content: `2026-09-24: ship search. Token ${githubToken}\n`,
        });
        expect(write).toMatchObject({ path: "goals.md", action: "write" });
        expect(write.after).not.toContain(githubToken);
        expect(events).toContainEqual({ type: "orchestration.changed", workspaceId });
        expect((yield* handlers["memory.list"]({ workspaceId })).map((file) => file.path)).toEqual([
          "MEMORY.md",
          "goals.md",
        ]);
        expect(yield* handlers["memory.read"]({ workspaceId, path: "goals.md" })).toMatchObject({
          path: "goals.md",
          content: "2026-09-24: ship search. Token [redacted]\n",
        });
        for (const escape of ["../../gram.db", "goals.txt", "/etc/passwd"]) {
          expect(
            yield* Effect.flip(
              handlers["memory.write"]({ workspaceId, path: escape, content: "x" }),
            ),
          ).toMatchObject({ _tag: "InvalidState" });
        }
        expect(yield* handlers["memory.delete"]({ workspaceId, path: "goals.md" })).toMatchObject({
          action: "delete",
        });

        const memory = yield* OrchestrationMemory;
        yield* memory.adopt(workspaceId, [{ path: "MEMORY.md", content: "# Memory index\n" }]);
        const versions = yield* handlers["memory.versions"]({ workspaceId });
        expect(versions.map((v) => [v.version, v.current])).toEqual([
          ["0001", false],
          ["0002", true],
        ]);
        yield* handlers["memory.restore"]({ workspaceId, version: "0001" });
        expect(yield* memory.currentVersion(workspaceId)).toBe("0001");

        expect(
          yield* Effect.flip(handlers["memory.list"]({ workspaceId: "nowhere" as WorkspaceId })),
        ).toMatchObject({ _tag: "NotFound", entity: "workspace" });
      }),
    ),
  );

  it.effect("an answer from the UI closes its question, then reaches the orchestrator", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const handlers = yield* dreamHandlers;
        const store = yield* ThreadStore;
        const { workspaceId, thread } = yield* openOrchestrator(world);
        yield* handlers["memory.write"]({
          workspaceId,
          path: "questions.md",
          content:
            "# Questions\n\n- Q1 (opened 2026-09-20): retry on 429?\n- Keep both installers?\n",
        });

        const answered = yield* handlers["question.answer"]({
          workspaceId,
          questionId: "Q1",
          question: "retry on 429?",
          answer: "Three times, then report.",
        });
        expect(answered.questionId).toBe("Q1");
        const text = JSON.stringify(yield* store.listMessages(thread.id));
        expect(text).toContain("Answer to Q1 in questions.md");
        expect(text).toContain("Three times, then report.");
        const file = yield* handlers["memory.read"]({ workspaceId, path: "questions.md" });
        expect(file.content).toContain("## Q1 · answered ");
        expect(file.content).toContain("Answer: Three times, then report.");

        // An entry without an id is found by its words and given one; a closed one isn't answered twice.
        expect(
          yield* handlers["question.answer"]({
            workspaceId,
            question: "Keep both installers?",
            answer: "uv only",
          }),
        ).toMatchObject({ questionId: "Q2" });
        const again = yield* Effect.flip(
          handlers["question.answer"]({
            workspaceId,
            questionId: "Q1",
            question: "",
            answer: "no",
          }),
        );
        expect(again).toMatchObject({ _tag: "InvalidState", message: "Q1 is closed already." });
      }),
    ),
  );

  it.effect("answers given while the orchestrator works wait as one, never interrupting it", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const handlers = yield* dreamHandlers;
        const runtimes = yield* ThreadRuntimes;
        const { workspaceId, thread, session } = yield* openOrchestrator(world);
        yield* handlers["memory.write"]({
          workspaceId,
          path: "questions.md",
          content:
            "# Questions\n\n- Q1 (opened 2026-09-20): retry on 429?\n- Q2 (opened 2026-09-20): keep MSI?\n",
        });
        yield* runtimes.send(thread.id, { text: "Plan the release." });
        yield* waitStatus(thread.id, "running");
        for (const [questionId, answer] of [
          ["Q1", "Three times."],
          ["Q2", "Yes."],
        ] as const) {
          yield* handlers["question.answer"]({ workspaceId, questionId, question: "", answer });
        }
        const queue = (yield* runtimes.snapshot).find(
          (each) => each.thread.id === thread.id,
        )?.queue;
        expect(queue).toHaveLength(1);
        expect(queue?.[0]?.input.text).toMatch(
          /Answer to Q1[\s\S]*Three times\.[\s\S]*Answer to Q2[\s\S]*Yes\./,
        );
        expect(session.steered).toEqual([]);
        expect(isQueuedAnswer(queue![0]!.input)).toBe(true);
        expect(isQueuedAnswer({ text: "Something else." })).toBe(false);
      }),
    ),
  );

  describe("an answer that fails on the way", () => {
    it.effect(
      "leaves a scrubbed answer's question open when nothing got through, and sends it once on retry",
      () =>
        inDreams((world) =>
          Effect.gen(function* () {
            const memory = yield* OrchestrationMemory;
            const answerIt = makeAnswerOnce();
            const { workspaceId } = yield* openOrchestrator(world);
            yield* memory.write(workspaceId, "questions.md", ANSWERED_FILE);
            const { delivery, held } = flaky(1, false);
            const answer = `Use the token ${githubToken}`;
            const failed = yield* Effect.flip(
              answerIt(memory, workspaceId, { ...ANSWER_TO, answer }, "2026-09-25", delivery),
            );
            expect(failed).toMatchObject({ message: "the session went away" });
            expect(yield* memory.read(workspaceId, "questions.md")).toContain("## Q1 · open");
            expect(held).toEqual([]);

            yield* answerIt(memory, workspaceId, { ...ANSWER_TO, answer }, "2026-09-25", delivery);
            expect(held).toHaveLength(1);
            const file = yield* memory.read(workspaceId, "questions.md");
            expect(file).toContain("## Q1 · answered 2026-09-25");
            expect(file).not.toContain(githubToken);
          }),
        ),
    );

    it.effect(
      "keeps an edit made while the answer was failing, and closes only its own entry",
      () =>
        inDreams((world) =>
          Effect.gen(function* () {
            const memory = yield* OrchestrationMemory;
            const answerIt = makeAnswerOnce();
            const { workspaceId } = yield* openOrchestrator(world);
            yield* memory.write(workspaceId, "questions.md", ANSWERED_FILE);
            const addQ2 = memory
              .modify(workspaceId, "questions.md", (now) => {
                const edit = askQuestion(now, { question: "Pin the runner?" }, "2026-09-25");
                return edit.ok
                  ? Effect.succeed({ content: edit.content, result: undefined })
                  : Effect.die(edit.problem);
              })
              .pipe(Effect.orDie, Effect.asVoid);
            const { delivery, held } = flaky(1, false, addQ2);
            yield* Effect.flip(
              answerIt(
                memory,
                workspaceId,
                { ...ANSWER_TO, answer: "Yes" },
                "2026-09-25",
                delivery,
              ),
            );
            const between = parseQuestions(yield* memory.read(workspaceId, "questions.md"));
            expect(between.map((q) => [q.id, q.open])).toEqual([
              ["Q1", true],
              ["Q2", true],
            ]);

            yield* answerIt(
              memory,
              workspaceId,
              { ...ANSWER_TO, answer: "Yes" },
              "2026-09-25",
              delivery,
            );
            const after = parseQuestions(yield* memory.read(workspaceId, "questions.md"));
            // The retry's edit asked the same words again, which is the same question, not a third.
            expect(after.map((q) => [q.id, q.open])).toEqual([
              ["Q2", true],
              ["Q1", false],
            ]);
            expect(held).toHaveLength(1);
          }),
        ),
    );

    it.effect(
      "counts an answer the runtime recorded before its session failed, and never sends it twice",
      () =>
        inDreams((world) =>
          Effect.gen(function* () {
            const memory = yield* OrchestrationMemory;
            const answerIt = makeAnswerOnce();
            const { workspaceId } = yield* openOrchestrator(world);
            yield* memory.write(workspaceId, "questions.md", ANSWERED_FILE);
            const { delivery, held } = flaky(1, true);
            expect(
              yield* answerIt(
                memory,
                workspaceId,
                { ...ANSWER_TO, answer: "Yes" },
                "2026-09-25",
                delivery,
              ),
            ).toEqual({ questionId: "Q1", delivered: "sent" });
            expect(yield* memory.read(workspaceId, "questions.md")).toContain("## Q1 · answered");
            // The UI still showed it open and the user pressed Send again.
            expect(
              yield* answerIt(
                memory,
                workspaceId,
                { ...ANSWER_TO, answer: "Yes" },
                "2026-09-25",
                delivery,
              ),
            ).toEqual({ questionId: "Q1", delivered: "sent" });
            expect(held).toHaveLength(1);
          }),
        ),
    );

    it.effect("finds an answer that got through before its close failed, however long ago", () =>
      inDreams((world) =>
        Effect.gen(function* () {
          const memory = yield* OrchestrationMemory;
          const answerIt = makeAnswerOnce();
          const { workspaceId } = yield* openOrchestrator(world);
          // What a delivery leaves when its close fails: the entry open, with the answer and its key.
          yield* memory.write(
            workspaceId,
            "questions.md",
            `${ANSWERED_FILE}Answer: Yes\nDelivery: pending k-1234\n`,
          );
          const { delivery, held, count } = flaky(0, false);
          held.push(`Answer to Q1 … (answer key k-1234)`);
          expect(
            yield* answerIt(
              memory,
              workspaceId,
              { ...ANSWER_TO, answer: "Yes" },
              "2026-09-25",
              delivery,
            ),
          ).toEqual({ questionId: "Q1", delivered: "sent" });
          expect(count()).toBe(0);
          const file = yield* memory.read(workspaceId, "questions.md");
          expect(file).toContain("## Q1 · answered 2026-09-25");
          expect(file).not.toContain("Delivery: pending");
        }),
      ),
    );

    it.effect(
      "serialises an id-less question answered by its words and by the id it was given",
      () =>
        inDreams((world) =>
          Effect.gen(function* () {
            const memory = yield* OrchestrationMemory;
            const answerIt = makeAnswerOnce();
            const { workspaceId } = yield* openOrchestrator(world);
            yield* memory.write(
              workspaceId,
              "questions.md",
              "# Questions\n\n- Keep both installers?\n",
            );
            const { delivery, held } = flaky(0, false, Effect.yieldNow);
            const question = "Keep both installers?";
            const [byWords, byId] = yield* Effect.all(
              [
                Effect.result(
                  answerIt(
                    memory,
                    workspaceId,
                    { question, answer: "Yes" },
                    "2026-09-25",
                    delivery,
                  ),
                ),
                Effect.result(
                  answerIt(
                    memory,
                    workspaceId,
                    { questionId: "Q1", question, answer: "No" },
                    "2026-09-25",
                    delivery,
                  ),
                ),
              ],
              { concurrency: "unbounded" },
            );
            expect([byWords._tag, byId._tag].toSorted()).toEqual(["Failure", "Success"]);
            expect(held).toHaveLength(1);
          }),
        ),
    );

    it.effect("takes two answers to one question one at a time, so only the first goes out", () =>
      inDreams((world) =>
        Effect.gen(function* () {
          const memory = yield* OrchestrationMemory;
          const answerIt = makeAnswerOnce();
          const { workspaceId } = yield* openOrchestrator(world);
          yield* memory.write(workspaceId, "questions.md", ANSWERED_FILE);
          const { delivery, held } = flaky(0, false, Effect.yieldNow);
          const [first, second] = yield* Effect.all(
            ["Yes", "No"].map((said) =>
              Effect.result(
                answerIt(
                  memory,
                  workspaceId,
                  { ...ANSWER_TO, answer: said },
                  "2026-09-25",
                  delivery,
                ),
              ),
            ),
            { concurrency: "unbounded" },
          );
          expect(first).toMatchObject({ _tag: "Success" });
          expect(second).toMatchObject({
            _tag: "Failure",
            failure: { message: "Q1 is closed already." },
          });
          expect(held).toHaveLength(1);
          expect(parseQuestions(yield* memory.read(workspaceId, "questions.md"))[0]).toMatchObject({
            open: false,
            answer: "Yes",
          });
        }),
      ),
    );
  });
});
