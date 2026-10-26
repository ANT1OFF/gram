// Archived threads and the watermarks a dream reads from.
import { describe, expect, it } from "@effect/vitest";
import { type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { renderClosedThread, ThreadArchive } from "./archive.ts";
import { Dreams } from "./dreams.ts";
import { completeTurn, openOrchestrator, waitReal, waitSent } from "./test-harness.ts";
import {
  githubToken,
  memoryRoot,
  inDreams,
  startDream,
  filesUnder,
  sessionsOf,
  exchange,
  adoptDream,
  dropDream,
} from "./dreams-service-kit.ts";

describe.skipIf(!hasGit)("dreams", () => {
  it.effect("a closed workspace thread is archived, scrubbed, and read by the next dream", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const archive = yield* ThreadArchive;
        const { workspaceId, thread, session, project } = yield* openOrchestrator(world);
        yield* runtimes.send(thread.id, { text: `The deploy token is ${githubToken}` });
        yield* waitSent(thread.id, 2);
        yield* completeTurn(session, "Noted.");

        const plain = yield* runtimes.create({
          projectRoot: world.repo,
          checkout: { kind: "main", path: world.repo },
          input: { text: "unrelated" },
        });
        yield* runtimes.close(plain.id);
        yield* runtimes.close(thread.id);

        const file = nodePath.join(memoryRoot(world), workspaceId, "archive", `${thread.id}.md`);
        yield* waitReal(
          "the archive",
          Effect.sync(() => fs.existsSync(file)),
        );
        const text = fs.readFileSync(file, "utf8");
        expect(text).toContain("# Orchestrator · shop");
        expect(text).toContain(`orchestrator thread ${thread.id}`);
        expect(text).toContain("The deploy token is [redacted]");
        expect(text).not.toContain(githubToken);
        expect((yield* archive.list(workspaceId)).map((entry) => entry.threadId)).toEqual([
          thread.id,
        ]);
        expect(project.id).toBe((yield* store.getWorkspace(workspaceId)).workspace.homeProjectId);

        const dreams = yield* Dreams;
        expect((yield* dreams.preview({ workspaceId })).archivedThreads).toBe(1);
        const dream = yield* dreams.start({ workspaceId, kind: "dream" });
        expect(dream.inputs.threadIds).toEqual([thread.id]);
        const names = filesUnder(nodePath.join(dream.outputDir, "input", "sessions"));
        expect(names).toHaveLength(1);
        expect(names[0]).toContain("archived");
        // A dream's own thread is not archived when it goes.
        yield* dreams.cancel(dream.id);
        yield* dreams.discard(dream.id);
        expect((yield* archive.list(workspaceId)).map((entry) => entry.threadId)).toEqual([
          thread.id,
        ]);
      }),
    ),
  );

  it.effect("a dream reads only what is past the watermarks, and a discard moves none", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const dreams = yield* Dreams;
        const { workspaceId, thread, session } = yield* openOrchestrator(world);
        yield* exchange(thread, session, "Deploy on merge, always.", "Noted: deploy on merge.");

        const first = yield* startDream(workspaceId);
        const [firstRead] = first.dream.inputs.reads ?? [];
        expect(firstRead).toMatchObject({
          threadId: thread.id,
          source: "thread",
          fromSeq: 1,
          file: "001-orchestrator-shop.md",
        });
        expect(Object.values(sessionsOf(first.dream))[0]).not.toContain("Earlier:");
        const adopted = yield* adoptDream(first.dream, first.session);
        expect(yield* store.listDreamWatermarks(workspaceId, adopted.adoptedVersion!)).toEqual([
          {
            threadId: thread.id,
            throughSeq: firstRead!.throughSeq,
            throughId: firstRead!.throughId,
            throughRev: firstRead!.throughRev,
            readAt: first.dream.createdAt,
          },
        ]);

        // Nothing new is nothing to read: the next dream tidies memory alone.
        const idle = yield* startDream(workspaceId);
        expect(idle.dream.inputs.reads).toEqual([]);
        yield* dropDream(idle.dream);

        yield* exchange(thread, session, "Retry on 429 too.", "Will retry on 429.");
        const second = yield* startDream(workspaceId);
        const [secondRead] = second.dream.inputs.reads ?? [];
        expect(secondRead?.fromSeq).toBe(firstRead!.throughSeq + 1);
        const text = Object.values(sessionsOf(second.dream))[0]!;
        expect(text).toContain(`Earlier: the messages before #${secondRead!.fromSeq} are already`);
        const fresh = text.slice(text.indexOf("--- New messages"));
        expect(fresh).toContain("Retry on 429 too.");
        expect(fresh).not.toContain("Deploy on merge");
        // The last consolidated message is quoted ahead of them, for context.
        expect(text.slice(0, text.indexOf("--- New messages"))).toContain(
          "Noted: deploy on merge.",
        );

        // Discarding it, or the adopted dream behind the marks, reads the same again.
        yield* dropDream(second.dream);
        const third = yield* startDream(workspaceId);
        expect(third.dream.inputs.reads).toEqual(second.dream.inputs.reads);
        yield* dreams.discard(first.dream.id);
        yield* dropDream(third.dream);
        const fourth = yield* startDream(workspaceId);
        expect(fourth.dream.inputs.reads).toEqual(second.dream.inputs.reads);
      }),
    ),
  );

  it.effect("a closed thread's archive is read on from where the open thread was", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const archive = yield* ThreadArchive;
        const { workspaceId, thread, session } = yield* openOrchestrator(world);
        yield* exchange(thread, session, "Deploy on merge, always.", "Noted.");
        const first = yield* startDream(workspaceId);
        yield* adoptDream(first.dream, first.session);

        yield* exchange(thread, session, "Retry on 429 too.", "Will retry.");
        yield* runtimes.close(thread.id);
        yield* waitReal(
          "the archive",
          archive.list(workspaceId).pipe(Effect.map((entries) => entries.length === 1)),
        );

        const second = yield* startDream(workspaceId);
        expect(second.dream.inputs.reads).toMatchObject([
          {
            threadId: thread.id,
            source: "archive",
            fromSeq: first.dream.inputs.reads![0]!.throughSeq + 1,
          },
        ]);
        const text = Object.values(sessionsOf(second.dream))[0]!;
        expect(text).toContain("Source: orchestrator thread");
        expect(text.slice(text.indexOf("--- New messages"))).not.toContain("Deploy on merge");
        expect(text).toContain("Retry on 429 too.");
        yield* adoptDream(second.dream, second.session);
        // Archived and read since: nothing of it is new.
        const third = yield* startDream(workspaceId);
        expect(third.dream.inputs.reads).toEqual([]);
      }),
    ),
  );

  it.effect("a dream reads within its budget, and what is past it waits for the next one", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const dreams = yield* Dreams;
        const { workspaceId, thread } = yield* openOrchestrator(world);
        const plain = yield* runtimes.create({
          projectRoot: world.repo,
          checkout: { kind: "main", path: world.repo },
          input: { text: "Port the cart" },
        });
        const worker = yield* waitSent(plain.id, 1);
        yield* completeTurn(worker, "Started.");
        // Eight long exchanges, about 128k characters: past a 20k-token budget whatever else is read.
        for (let at = 1; at <= 8; at++) {
          yield* exchange(
            plain,
            worker,
            `Step ${at}: ${"detail ".repeat(2200)}`,
            `Step ${at} done.`,
          );
        }

        const preview = yield* dreams.preview({ workspaceId, kind: "dream", budgetTokens: 20_000 });
        expect(preview.sources).toEqual([]);
        const plan = preview.dream!;
        expect(plan).toMatchObject({ memoryVersion: "0001", fromStart: true, threads: 2 });
        expect(plan.backlog.threads).toBe(1);
        expect(plan.backlog.messages).toBeGreaterThan(0);
        expect(plan.estimatedTokens).toBeLessThanOrEqual(20_000);
        expect(preview.notes[0]).toMatch(
          /^1 thread \(\d+ new messages, ≈\d+k tokens\) left for the next dream/,
        );

        const first = yield* dreams.start({ workspaceId, kind: "dream", budgetTokens: 20_000 });
        expect(first).toMatchObject({ budgetTokens: 20_000, backlog: plan.backlog });
        expect(first.notes).toEqual([preview.notes[0]]);
        // The orchestrator's thread is read first.
        expect(first.inputs.reads?.map((read) => read.threadId)).toEqual([thread.id, plain.id]);
        const cut = first.inputs.reads![1]!;
        const text = sessionsOf(first)[cut.file!]!;
        expect(text).toMatch(/Later: \d+ newer messages are left for the next dream\./);
        expect(text).toContain("Step 1:");
        expect(text).not.toContain("Step 8:");
        yield* adoptDream(first, yield* waitSent(first.threadId as ThreadId, 1));

        // Adopted, the backlog is the next dream's, read on from where the cut was.
        const next = (yield* dreams.preview({ workspaceId, kind: "dream" })).dream!;
        expect(next).toMatchObject({ fromStart: false, threads: 1, backlog: { threads: 0 } });
        expect(next.messages).toBe(plan.backlog.messages);
        const second = yield* dreams.start({ workspaceId, kind: "dream" });
        expect(second.inputs.reads).toMatchObject([
          { threadId: plain.id, fromSeq: cut.throughSeq + 1 },
        ]);
        expect(Object.values(sessionsOf(second))[0]).toContain("Step 8:");
        expect("backlog" in second && second.backlog?.threads).toBe(0);
      }),
    ),
  );

  it.effect("an archive too long for one file is read on from its mark", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const archive = yield* ThreadArchive;
        const { workspaceId, thread, session } = yield* openOrchestrator(world);
        yield* exchange(thread, session, "Deploy on merge, always.", "Noted.");
        // Fifteen long messages: within what an archive keeps, past what one dream file holds.
        const big = "t-big" as ThreadId;
        const text = renderClosedThread(
          { id: big, title: "Big worker" },
          Array.from({ length: 15 }, (_, index) => ({
            seq: index + 1,
            message: {
              id: `m${index + 1}`,
              role: "user",
              parts: [{ type: "text", text: `Part ${index + 1}. ${"x".repeat(13_000)}` }],
            } as never,
          })),
        )!;
        yield* archive.write(workspaceId, big, text);
        // Archived before any dream read it, as a clock would have it.
        fs.utimesSync(nodePath.join(memoryRoot(world), workspaceId, "archive", "t-big.md"), 0, 0);

        const first = yield* startDream(workspaceId);
        const cut = first.dream.inputs.reads!.find((read) => read.threadId === big)!;
        expect(cut.throughSeq).toBeLessThan(15);
        const adopted = yield* adoptDream(first.dream, first.session);

        const second = yield* startDream(workspaceId);
        expect(second.dream.inputs.reads).toMatchObject([
          { threadId: big, source: "archive", fromSeq: cut.throughSeq + 1, throughSeq: 15 },
        ]);
        expect(
          (yield* store.listDreamWatermarks(workspaceId, adopted.adoptedVersion!)).map(
            (mark) => mark.threadId,
          ),
        ).toEqual([big, thread.id].toSorted());
        expect(Object.values(sessionsOf(second.dream))[0]).toContain("Part 15.");
      }),
    ),
  );

  it.effect(
    "a thread's digest is kept with its mark, read by the next dream, and goes with it",
    () =>
      inDreams(
        (world) =>
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const archive = yield* ThreadArchive;
            const { workspaceId, thread, session } = yield* openOrchestrator(world);
            yield* exchange(thread, session, "Deploy on merge, always.", "Noted.");
            const first = yield* startDream(workspaceId);
            const file = first.dream.inputs.reads![0]!.file!;
            const digests = nodePath.join(first.dream.outputDir, "work", "digests");
            fs.writeFileSync(
              nodePath.join(digests, file),
              `The shop orchestrator. Deploys on merge. Key ${githubToken}. ${"more ".repeat(600)}`,
            );
            const adopted = yield* adoptDream(first.dream, first.session);
            const [kept] = yield* store.listDreamWatermarks(workspaceId, adopted.adoptedVersion!);
            expect(kept?.digest).toContain("The shop orchestrator. Deploys on merge.");
            expect(kept?.digest).not.toContain(githubToken);
            expect(kept!.digest!.length).toBeLessThanOrEqual(2000);

            // The next dream gets it in place of the old messages, and keeps it when it writes none.
            yield* exchange(thread, session, "Retry on 429 too.", "Will retry.");
            const second = yield* startDream(workspaceId);
            const text = Object.values(sessionsOf(second.dream))[0]!;
            expect(text).toContain("Digest of the conversation before, from earlier dreams");
            expect(text).toContain("> The shop orchestrator. Deploys on merge.");
            const again = yield* adoptDream(second.dream, second.session);
            const [carried] = yield* store.listDreamWatermarks(workspaceId, again.adoptedVersion!);
            expect(carried?.digest).toBe(kept?.digest);
            expect(carried!.throughSeq).toBeGreaterThan(kept!.throughSeq);

            // A closed thread's mark lasts while its archive does: pruned past the cap, it goes.
            const other = yield* runtimes.create({
              projectRoot: world.repo,
              checkout: { kind: "main", path: world.repo },
              workspaceId,
              input: { text: "Port the cart" },
            });
            yield* completeTurn(yield* waitSent(other.id, 1), "Started.");
            yield* runtimes.close(thread.id);
            yield* waitReal(
              "the archive",
              archive.list(workspaceId).pipe(Effect.map((entries) => entries.length === 1)),
            );
            expect(
              yield* store.listDreamWatermarks(workspaceId, again.adoptedVersion!),
            ).toHaveLength(1);
            yield* runtimes.close(other.id);
            yield* waitReal(
              "the cap to prune the orchestrator's transcript",
              archive
                .list(workspaceId)
                .pipe(
                  Effect.map(
                    (entries) => entries.map((entry) => entry.threadId).join() === other.id,
                  ),
                ),
            );
            yield* waitReal(
              "its mark to go",
              store
                .listDreamWatermarks(workspaceId, again.adoptedVersion!)
                .pipe(Effect.map((marks) => marks.length === 0)),
            );
          }),
        { caps: { maxFiles: 1 } },
      ),
  );
});
