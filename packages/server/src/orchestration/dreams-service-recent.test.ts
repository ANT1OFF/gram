// A memory update reads what happened since the last one, not transcripts; in Auto it applies
// itself within guard rails, and Revert undoes it.
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CHARTER, type Dream, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Dreams } from "./dreams.ts";
import { DECISIONS_FILE, MEMORY_FILE_MAX_BYTES, OrchestrationMemory } from "./memory.ts";
import { Orchestration } from "./service.ts";
import { completeTurn, openOrchestrator, settle, waitReal, waitSent } from "./test-harness.ts";
import {
  adoptDream,
  finishDream,
  githubToken,
  inDreams,
  reportSomething,
  sessionsOf,
  startDream,
  writeOutput,
} from "./dreams-service-kit.ts";

const SINCE = "001-since-the-last-memory-update.md";

/**
 * Says `done` for an automatic run and waits until it has stopped, or applied itself (or found
 * nothing to apply) and closed its thread.
 */
const finishAuto = (dream: Dream, session: Parameters<typeof completeTurn>[0]) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* completeTurn(session, "done");
    return yield* waitReal(
      "automatic run ended",
      Effect.gen(function* () {
        const row = yield* store.getDream(dream.id);
        if (row.status === "failed" || row.status === "canceled") return row;
        if (row.adoptionFailure !== undefined) return row;
        const closed = (yield* store.listClosed).some(
          (entry) => entry.thread.id === dream.threadId,
        );
        return closed && row;
      }),
    );
  });

describe.skipIf(!hasGit)("memory updates that read what happened since the last", () => {
  it.effect("read only what is new since the last adopted one, however long the threads", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const { workspaceId, thread, session } = yield* openOrchestrator(world);
        // A long conversation: what an update reading transcripts would have paid for.
        const long = "transcript-only ".repeat(20_000);
        yield* runtimes.send(thread.id, { text: "Plan the deploy." });
        yield* waitSent(thread.id, 2);
        yield* completeTurn(session, long);

        yield* reportSomething(workspaceId, "Moved the deploy to Fridays.", {
          learned: "The deploy script needs DEPLOY_ENV set.",
        });
        const first = yield* startDream(workspaceId);
        const read = sessionsOf(first.dream);
        expect(Object.keys(read)).toEqual([SINCE]);
        expect(read[SINCE]).toContain("Moved the deploy to Fridays.");
        expect(read[SINCE]).toContain("Learned: The deploy script needs DEPLOY_ENV set.");
        expect(read[SINCE]).not.toContain("transcript-only");
        expect(first.dream.inputs.recent).toMatchObject({ reports: 2 });
        expect(first.dream.inputs.recent!.estimatedTokens).toBeLessThan(2_000);
        yield* adoptDream(first.dream, first.session);

        // The next one reads what came after, and nothing before it again.
        yield* reportSomething(workspaceId, "Added a staging check.");
        const dreams = yield* Dreams;
        const plan = (yield* dreams.preview({ workspaceId, kind: "dream" })).dream;
        expect(plan).toMatchObject({ reports: 1 });
        const second = yield* startDream(workspaceId);
        const next = sessionsOf(second.dream)[SINCE]!;
        expect(next).toContain("Added a staging check.");
        expect(next).not.toContain("Moved the deploy to Fridays.");
        expect(second.dream.inputs.recent!.estimatedTokens).toBeLessThan(1_000);
      }),
    ),
  );

  it.effect("reads answered questions and merges, and refuses to run on nothing", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const dreams = yield* Dreams;
        const { workspaceId } = yield* openOrchestrator(world);
        expect(
          (yield* Effect.flip(dreams.start({ workspaceId, kind: "dream" }))).message,
        ).toContain("Nothing new since the last memory update");
        yield* store.appendOrchestrationEvent(workspaceId, {
          at: 5,
          kind: "merge",
          data: { threadId: "t-merged", pr: "acme/shop#12" },
        });
        const dream = yield* dreams.start({ workspaceId, kind: "dream" });
        yield* waitSent(dream.threadId as ThreadId, 1);
        expect(sessionsOf(dream)[SINCE]).toContain("merged · acme/shop#12");
        expect(dream.inputs.recent).toMatchObject({ merges: 1, reports: 0 });
      }),
    ),
  );

  it.effect(
    "in Auto, applies itself as a version naming its run, never touching standing decisions",
    () =>
      inDreams((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const memory = yield* OrchestrationMemory;
          const orchestration = yield* Orchestration;
          const { workspaceId } = yield* openOrchestrator(world);
          const ruling = "# Standing decisions\n\n- Visual PRs merge when green.\n";
          yield* memory.write(workspaceId, DECISIONS_FILE, ruling);
          yield* orchestration.setCharter(workspaceId, {
            ...(yield* store.getWorkspace(workspaceId)).charter,
            memoryUpdateMode: "auto",
          });
          // No mode given: the workspace's decides.
          const { dream, session } = yield* startDream(workspaceId);
          expect(dream.mode).toBe("auto");
          writeOutput(dream, {
            "REPORT.md": "Filed the deploy day.\n\n# Merged\n",
            "MEMORY.md": "# Memory index\n\n- [[decisions]]: what was decided\n",
            "decisions.md": `---\nname: decisions\ndescription: what was decided\ntype: decision\n---\n\n- 2026-11-24: deploy on Fridays (thread t-1). Key ${githubToken}\n`,
            [DECISIONS_FILE]: "# Standing decisions\n\n- Nothing merges without review.\n",
          });
          const ended = yield* finishAuto(dream, session);
          expect(ended.adoptedVersion).toBe("0002");
          expect(ended.summary).toMatch(/^Filed the deploy day \(/);
          // The user's rulings change only by their word.
          expect(yield* memory.read(workspaceId, DECISIONS_FILE)).toBe(ruling);
          // Nothing shaped like a secret is written.
          const decisions = yield* memory.read(workspaceId, "decisions.md");
          expect(decisions).toContain("deploy on Fridays");
          expect(decisions).not.toContain(githubToken);
          // History says where the version came from.
          const made = (yield* memory.versions(workspaceId)).find((v) => v.version === "0002");
          expect(made?.source).toMatchObject({ dreamId: dream.id, mode: "auto" });
          expect(made?.source?.summary).toContain("Filed the deploy day");
          expect(made?.basedOn).toBe("0001");
        }),
      ),
  );

  it.effect("in Auto, output past memory's caps is never applied", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const memory = yield* OrchestrationMemory;
        const { workspaceId } = yield* openOrchestrator(world);
        const before = yield* memory.index(workspaceId);
        const { dream, session } = yield* startDream(workspaceId, undefined, "auto");
        writeOutput(dream, { "notes.md": "x".repeat(MEMORY_FILE_MAX_BYTES + 1) });
        const ended = yield* finishDream(dream, session, "failed");
        expect(ended.failure).toBe("over_caps");
        expect(ended.adoptedVersion).toBeUndefined();
        expect(yield* memory.currentVersion(workspaceId)).toBe("0001");
        expect(yield* memory.index(workspaceId)).toBe(before);
      }),
    ),
  );

  it.effect("Revert points memory back at the version a run was made from, once", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const dreams = yield* Dreams;
        const memory = yield* OrchestrationMemory;
        const { workspaceId } = yield* openOrchestrator(world);
        const before = yield* memory.index(workspaceId);
        const { dream, session } = yield* startDream(workspaceId, undefined, "auto");
        writeOutput(dream, { "MEMORY.md": "# Applied by itself\n" });
        const ended = yield* finishAuto(dream, session);
        expect(yield* memory.index(workspaceId)).toBe("# Applied by itself\n");

        expect(yield* dreams.revert(dream.id)).toBe(workspaceId);
        expect(yield* memory.currentVersion(workspaceId)).toBe("0001");
        expect(yield* memory.index(workspaceId)).toBe(before);
        expect((yield* dreams.list(workspaceId))[0]?.revertedAt).toBeDefined();
        // Both versions stay in History; a second revert has nothing to undo.
        expect((yield* memory.versions(workspaceId)).map((v) => v.version)).toEqual([
          "0001",
          ended.adoptedVersion!,
        ]);
        expect((yield* Effect.flip(dreams.revert(dream.id))).message).toContain(
          "Restore a version from History",
        );
        // What it read stays spent, so the next run doesn't apply it again.
        expect(
          (yield* Effect.flip(dreams.start({ workspaceId, kind: "dream" }))).message,
        ).toContain("Nothing new");
      }),
    ),
  );

  it.effect("in Auto, a run that changes nothing makes no version and spends what it read", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const memory = yield* OrchestrationMemory;
        const { workspaceId } = yield* openOrchestrator(world);
        const { dream, session } = yield* startDream(workspaceId, undefined, "auto");
        writeOutput(dream, { "REPORT.md": "Nothing to file.\n" });
        const ended = yield* finishAuto(dream, session);
        expect(ended.adoptedVersion).toBeUndefined();
        expect(ended.summary).toBe("Nothing to file (nothing changed)");
        expect((yield* memory.versions(workspaceId)).map((v) => v.version)).toEqual(["0001"]);
        expect((yield* store.getDreamCursor(workspaceId))?.reportSeq).toBe(
          ended.inputs.recent?.throughReportSeq,
        );
      }),
    ),
  );

  it.effect("switching to Auto discards the drafts waiting for review", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const dreams = yield* Dreams;
        const orchestration = yield* Orchestration;
        const { workspaceId } = yield* openOrchestrator(world);
        const { dream, session } = yield* startDream(workspaceId);
        writeOutput(dream, { "MEMORY.md": "# Draft\n" });
        yield* finishDream(dream, session, "completed");
        expect((yield* dreams.list(workspaceId)).map((d) => d.id)).toEqual([dream.id]);
        yield* orchestration.setCharter(workspaceId, {
          ...(yield* store.getWorkspace(workspaceId)).charter,
          memoryUpdateMode: "auto",
        });
        yield* waitReal(
          "draft discarded",
          dreams.list(workspaceId).pipe(Effect.map((rows) => rows.length === 0)),
        );
        expect(fs.existsSync(nodePath.join(dream.outputDir))).toBe(false);
      }),
    ),
  );

  it.effect("runs on its schedule when something is new, and a waiting draft holds it", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const { workspaceId } = yield* openOrchestrator(world);
        yield* orchestration.setCharter(workspaceId, {
          ...DEFAULT_CHARTER,
          ...(yield* store.getWorkspace(workspaceId)).charter,
          memoryUpdateEveryHours: 3,
        });
        // Nothing new: the schedule starts nothing.
        yield* TestClock.adjust("4 hours");
        yield* settle;
        expect(yield* store.listDreams(workspaceId)).toEqual([]);

        yield* reportSomething(workspaceId, "Shipped the cart.");
        yield* TestClock.adjust("10 minutes");
        const first = yield* waitReal(
          "scheduled run",
          store.listDreams(workspaceId).pipe(Effect.map((rows) => rows[0])),
        );
        expect(first).toMatchObject({ kind: "dream", mode: "review" });
        const session = yield* waitSent(first.threadId as ThreadId, 1);
        writeOutput(first, { "MEMORY.md": "# Draft\n" });
        yield* finishDream(first, session, "completed");

        // In Review, a draft that waits holds the next run, so drafts don't pile up.
        yield* reportSomething(workspaceId, "Shipped search.");
        yield* TestClock.adjust("4 hours");
        yield* settle;
        expect(yield* store.listDreams(workspaceId)).toHaveLength(1);
      }),
    ),
  );
});
