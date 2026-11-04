import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { ThreadId, TurnId } from "@gram/contracts";
import { Checkpoints, CheckpointsLive, ProcLive, undoTurnFiles } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-repo.ts";
import { endCheckpointId } from "./turn-hooks.ts";
import { makeTurnUndo, UNDO_RUNNING } from "./turn-undo.ts";

const TURN = "turn-1" as TurnId;
const GitLayer = CheckpointsLive.pipe(Layer.provideMerge(ProcLive));
const TestLayer = Layer.mergeAll(RuntimeTestLayer, GitLayer);

/** Real git undo where the folder of `z/file` turns read-only once `git apply --check` passed. */
const failsWriting = (repo: string, start: string, end: string) =>
  undoTurnFiles(repo, start, end, {
    afterCheck: () => fs.chmodSync(nodePath.join(repo, "z"), 0o555),
  }).pipe(
    Effect.ensuring(Effect.sync(() => fs.chmodSync(nodePath.join(repo, "z"), 0o755))),
    Effect.provide(ProcLive),
  );

/** An undo whose git work never ends, to interrupt. */
const neverEnds = () => Effect.never;

/** The thread's transcript receipts. */
const receipts = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return (yield* store.listMessages(threadId)).flatMap((m) =>
      m.parts.flatMap((p) => (p.type === "data-turn-undo" ? [p.data] : [])),
    );
  });

const statusIs = (threadId: ThreadId, status: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* waitFor(
      `status ${status}`,
      runtimes.status(threadId).pipe(Effect.map((s) => s === status)),
    );
  });

/**
 * A real runtime with the fake agent, in a real repository: a thread whose turn-1 edited
 * `tracked.txt` and created `new.txt`, with the real checkpoints around it.
 */
const setup = (dirs: Array<string>, options: { readonly input?: string } = {}) =>
  Effect.gen(function* () {
    const dir = tempDir();
    dirs.push(dir);
    const repo = makeRepo(dir);
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const checkpoints = yield* Checkpoints;
    const thread = yield* runtimes.create({
      projectRoot: repo,
      checkout: { kind: "main", path: repo },
      ...(options.input === undefined ? {} : { input: { text: options.input } }),
    });
    yield* checkpoints.snapshot(repo, thread.id, TURN);
    write(nodePath.join(repo, "tracked.txt"), "turn 1\n");
    write(nodePath.join(repo, "new.txt"), "created\n");
    yield* checkpoints.snapshot(repo, thread.id, endCheckpointId(TURN));
    const read = (rel: string) => {
      const path = nodePath.join(repo, rel);
      return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : undefined;
    };
    const refreshed: Array<string> = [];
    const undoWith = (wrap: typeof checkpoints.undoTurn = checkpoints.undoTurn) =>
      makeTurnUndo({
        store,
        runtimes,
        checkpoints: { resolve: checkpoints.resolve, undoTurn: wrap },
        refresh: (cwd) => Effect.sync(() => void refreshed.push(cwd)),
      });
    return { repo, thread, read, refreshed, undoWith, checkpoints };
  });

describe.skipIf(!hasGit)("undoing a turn from its footer", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it.live("puts the turn's files back and leaves a receipt in the transcript", () =>
    Effect.gen(function* () {
      const { repo, thread, read, refreshed, undoWith } = yield* setup(dirs);
      yield* statusIs(thread.id, "idle");
      const receipt = yield* undoWith()(thread.id, TURN);
      expect(receipt).toMatchObject({ turnId: TURN, files: 2 });
      expect(read("tracked.txt")).toBe("tracked\n");
      expect(read("new.txt")).toBeUndefined();
      expect(yield* receipts(thread.id)).toEqual([receipt]);
      expect(refreshed).toEqual([repo]);
    }).pipe(Effect.provide(TestLayer)),
  );

  // Third review, findings 2 and 3: the agent session is left alone, sends wait, and an
  // interrupted undo leaves the thread free.
  it.live(
    "holds a send made during the undo until the receipt is in, leaving the session open",
    () =>
      Effect.gen(function* () {
        const fake = yield* FakeAgentControl;
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const { thread, read, undoWith, checkpoints } = yield* setup(dirs);
        yield* statusIs(thread.id, "idle");
        const session = yield* fake.latest(thread.id);
        const scope = yield* Effect.scope;
        let sending: Fiber.Fiber<unknown, unknown> | undefined;
        // A message sent while git works: it waits for the thread, rather than being refused.
        const racing: typeof checkpoints.undoTurn = (repo, start, end) =>
          Effect.gen(function* () {
            sending = yield* runtimes.send(thread.id, { text: "next" }).pipe(Effect.forkIn(scope));
            for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
            expect(session.sent).toHaveLength(0);
            return yield* checkpoints.undoTurn(repo, start, end);
          });

        const receipt = yield* undoWith(racing)(thread.id, TURN);
        yield* Fiber.join(sending!);

        expect(receipt).toMatchObject({ files: 2 });
        expect(read("tracked.txt")).toBe("tracked\n");
        expect(session.closed).toBe(false);
        expect(session.sent.map((input) => input.text)).toEqual(["next"]);
        // The receipt comes before the message that waited.
        const messages = yield* store.listMessages(thread.id);
        const at = (test: (m: (typeof messages)[number]) => boolean) => messages.findIndex(test);
        expect(at((m) => m.parts.some((p) => p.type === "data-turn-undo"))).toBeLessThan(
          at((m) => m.role === "user"),
        );
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("leaves the thread free when the undo is interrupted", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const { thread, undoWith } = yield* setup(dirs);
      yield* statusIs(thread.id, "idle");
      const undoing = yield* Effect.forkScoped(undoWith(neverEnds)(thread.id, TURN));
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      yield* Fiber.interrupt(undoing);

      const sent = yield* runtimes.send(thread.id, { text: "after" }).pipe(Effect.result);
      expect(sent._tag).toBe("Success");
      yield* statusIs(thread.id, "running");
      expect(yield* receipts(thread.id)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("refuses while the agent works, touching nothing and writing no receipt", () =>
    Effect.gen(function* () {
      const { thread, read, undoWith } = yield* setup(dirs, { input: "go" });
      yield* statusIs(thread.id, "running");
      const error = yield* undoWith()(thread.id, TURN).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "InvalidState", message: UNDO_RUNNING });
      expect(read("tracked.txt")).toBe("turn 1\n");
      expect(yield* receipts(thread.id)).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("refuses a turn that hasn't ended: it has no end checkpoint yet", () =>
    Effect.gen(function* () {
      const { repo, thread, undoWith, checkpoints } = yield* setup(dirs);
      yield* statusIs(thread.id, "idle");
      yield* checkpoints.snapshot(repo, thread.id, "turn-2");
      const error = yield* undoWith()(thread.id, "turn-2" as TurnId).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "InvalidState", message: UNDO_RUNNING });
      expect(yield* receipts(thread.id)).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("says why it refused: a file changed since, or the edits were committed", () =>
    Effect.gen(function* () {
      const { repo, thread, read, undoWith } = yield* setup(dirs);
      yield* statusIs(thread.id, "idle");
      write(nodePath.join(repo, "tracked.txt"), "the user's fix\n");
      const changed = yield* undoWith()(thread.id, TURN).pipe(Effect.flip);
      expect(changed.message).toBe(
        "Undo not available: 1 file changed again since this turn (tracked.txt), by a later turn or by you. View the changes to undo them by hand.",
      );
      expect(read("new.txt")).toBe("created\n");

      write(nodePath.join(repo, "tracked.txt"), "turn 1\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "the agent's edits");
      const committed = yield* undoWith()(thread.id, TURN).pipe(Effect.flip);
      expect(committed.message).toBe(
        "Undo not available: a commit made since this turn started changes its files (new.txt, tracked.txt). Undo doesn't revert commits.",
      );
      expect(read("tracked.txt")).toBe("turn 1\n");
      expect(yield* receipts(thread.id)).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  // Final review: a failed apply is reported as such, with the files to check in the receipt.
  it.live.skipIf(process.getuid?.() === 0)(
    "reports a failed apply with its files in the receipt, never that nothing changed",
    () =>
      Effect.gen(function* () {
        const { repo, thread, undoWith, checkpoints } = yield* setup(dirs);
        yield* statusIs(thread.id, "idle");
        write(nodePath.join(repo, "z", "file"), "committed\n");
        run(repo, "add", "-A");
        run(repo, "commit", "-qm", "z");
        yield* checkpoints.snapshot(repo, thread.id, "turn-2");
        write(nodePath.join(repo, "z", "file"), "the turn's edit\n");
        yield* checkpoints.snapshot(repo, thread.id, endCheckpointId("turn-2" as TurnId));

        const error = yield* undoWith(failsWriting)(thread.id, "turn-2" as TurnId).pipe(
          Effect.flip,
        );
        expect(error).toMatchObject({ _tag: "GitError" });
        expect(error.message).toMatch(/^Undo failed partway: /);
        expect(error.message).toContain("These files may have changed: z/file.");
        expect(error.message).toContain("Check them with View changes.");
        expect(error.message).not.toContain("Nothing was changed");
        expect(yield* receipts(thread.id)).toEqual([
          { turnId: "turn-2", files: 1, at: expect.any(Number), failed: ["z/file"] },
        ]);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.live("refuses a turn with no checkpoint in this folder", () =>
    Effect.gen(function* () {
      const { thread, undoWith } = yield* setup(dirs);
      const error = yield* undoWith()(thread.id, "turn-elsewhere" as TurnId).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "NotFound", entity: "checkpoint" });
    }).pipe(Effect.provide(TestLayer)),
  );
});
