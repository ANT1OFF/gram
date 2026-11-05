// Routines and worker memory, the third review's findings on #198, each reproduced through the real
// service: adding or widening a routine always asks the user while off and remove don't; turning a
// routine off and on keeps the claim of a worker it left half made; a run in flight doesn't bring
// back a removed routine's state; and a worker reads memory through the anchored tree, without
// private or credential-shaped files.
import { describe, expect, it } from "@effect/vitest";
import { type ThreadId, type WorkspaceId } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { anchoredRequest } from "../orchestration/anchored-files.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { hasGit } from "../git/test-repo.ts";
import { workerThreadId } from "../orchestration/outbox.ts";
import { Orchestration } from "../orchestration/service.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  settle,
  spawn,
  waitReal,
  withServer,
} from "../orchestration/test-harness.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  editRoutine,
  editRoutines,
  ranAfter,
  routineNow,
  runNow,
  stageState,
  stateOf,
  workerRoutine,
} from "./test-kit.ts";

const SLOW = { timeout: 90_000 } as const;

/** The paths a `memory_list` result names. */
const listed = (result: unknown) =>
  ((result as { files: ReadonlyArray<{ path: string }> }).files ?? []).map((file) => file.path);

describe.skipIf(!hasGit)("routines and worker memory: third review", () => {
  it.effect(
    "[12] asks the user to add, turn back on or widen a routine, from the orchestrator too, but not to turn one off or remove it",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "flakes" });
            yield* completeTurn(worker.session);
            const asks = (
              threadId: ThreadId,
              audience: "orchestrator" | "worker",
              name: string,
              input: unknown,
            ) =>
              Effect.gen(function* () {
                const tool = registry
                  .forThread(threadId, audience)
                  .find((each) => each.descriptor.name === name);
                return yield* tool!.needsApproval!(input);
              });
            const create = {
              name: "Nightly flake sweep",
              brief: "Rerun the flaky suites.",
              schedule: "daily 02:00",
              target: "worker",
            };
            expect(yield* asks(thread.id, "orchestrator", "routine_create", create)).toBe(true);
            expect(yield* asks(worker.thread.id, "worker", "routine_create", create)).toBe(true);
            const update = (change: Record<string, unknown>) =>
              asks(thread.id, "orchestrator", "routine_update", { routine: "x", ...change });
            for (const widening of [
              { off: false },
              { schedule: "every 1 hour" },
              { brief: "Do more." },
              { project: "shop" },
              { model: "claude:fake-opus" },
              { target: "orchestrator" },
              { name: "Renamed" },
              { off: true, brief: "Do more." },
            ]) {
              expect(yield* update(widening), JSON.stringify(widening)).toBe(true);
            }
            expect(yield* update({ off: true })).toBe(false);
            expect(yield* update({ remove: true })).toBe(false);
          }),
        );
      }),
    SLOW,
  );

  it.effect(
    "[13] keeps the claim of a worker a crash left half made when the routine is turned off and back on, and finishes it",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const { project, workspaceId, thread: orchestrator } = yield* openOrchestrator(world);
            const routine = yield* workerRoutine(workspaceId, project.id);
            const slot = routine.nextRunAt!;
            const requestId = `routine:${routine.id}:${slot}`;
            const threadId = workerThreadId(workspaceId, requestId);
            // A run claimed its slot and its worker's row was made; the brief never went out.
            yield* stageState(routine.id, { ...stateOf(routine), claim: { requestId, slot } });
            const runtimes = yield* ThreadRuntimes;
            yield* runtimes.create({
              id: threadId,
              projectRoot: world.repo,
              checkout: { kind: "main", path: world.repo },
              title: routine.name,
              workspaceId,
              spawnedBy: {
                threadId: orchestrator.id,
                feature: "routine-ci-triage",
                routine: { id: routine.id, name: routine.name },
              },
              deferOpen: true,
            });
            yield* editRoutine(routine.id, (each) => ({ ...each, off: true }));
            const off = yield* waitReal(
              "the routine off",
              routineNow(routine.id).pipe(
                Effect.map((each) => (each.nextRunAt === undefined ? each : undefined)),
              ),
            );
            expect(off.claim).toEqual({ requestId, slot });
            yield* editRoutine(routine.id, (each) => {
              const { off: _off, ...rest } = each;
              return rest;
            });
            const on = yield* waitReal(
              "the routine back on",
              routineNow(routine.id).pipe(
                Effect.map((each) => (each.nextRunAt === undefined ? undefined : each)),
              ),
            );
            expect(on.claim?.requestId).toBe(requestId);
            const now = yield* Clock.currentTimeMillis;
            expect(on.nextRunAt!).toBeGreaterThan(now);
            yield* TestClock.adjust(on.nextRunAt! - now);
            const ran = yield* ranAfter(routine.id, on.nextRunAt!);
            expect(ran.lastRun).toMatchObject({ outcome: "started", threadId });
            const fake = yield* FakeAgentControl;
            const brief = yield* waitReal(
              "the half-made worker's brief",
              Effect.sync(
                () => fake.sessions.find((each) => each.options.threadId === threadId)?.sent[0],
              ),
            );
            expect(brief.text).toContain('scheduled routine "CI triage"');
          }),
        );
      }),
    SLOW,
  );

  it.effect(
    "[14] doesn't bring back a removed routine's state from a run that was still going",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const orchestration = yield* Orchestration;
            const { project, workspaceId, session } = yield* openOrchestrator(world);
            const routine = yield* workerRoutine(workspaceId, project.id);
            // The orchestrator's own spawn holds the spawn lock, so the run waits inside its spawn.
            const racing = yield* session
              .callTool("spawn_worker", {
                project: "shop",
                feature: "racing",
                title: "Racing spawn",
                brief: "Do the racing work.",
              })
              .pipe(Effect.forkScoped);
            for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
            const run = yield* runNow(routine.id).pipe(Effect.forkScoped);
            for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
            // Removed while its run is under way: the charter's write prunes its state.
            yield* editRoutines(workspaceId as WorkspaceId, () => []);
            yield* Fiber.join(racing);
            yield* Fiber.await(run);
            yield* settle;
            expect((yield* orchestration.routineStates(workspaceId))[routine.id]).toBeUndefined();
          }),
        );
      }),
    SLOW,
  );

  it.effect(
    "[15] keeps private and credential-shaped memory from a worker, and lets its orchestrator read it",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const { session } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "reader" });
            yield* completeTurn(worker.session);
            const files: Record<string, string> = {
              "conventions.md": "Tabs, not spaces.",
              "private/plans.md": "Not for workers.",
              "people.private.md": "Not for workers.",
              "deploy-token.md": "Not for workers.",
              "api-keys.md": "Not for workers.",
              "notes.md": "---\nprivate: true\n---\nNot for workers.",
            };
            for (const [path, content] of Object.entries(files)) {
              yield* session.callTool("memory_write", { path, content });
            }
            const all = listed(yield* session.callTool("memory_list", {}));
            for (const path of Object.keys(files)) expect(all).toContain(path);
            const seen = listed(yield* worker.session.callTool("memory_list", {}));
            expect(seen).toContain("conventions.md");
            // `notes.md` is listed (its name is plain) but its front matter keeps it from being read.
            for (const path of [
              "private/plans.md",
              "people.private.md",
              "deploy-token.md",
              "api-keys.md",
            ]) {
              expect(seen).not.toContain(path);
            }
            const read = (path: string) => worker.session.callTool("memory_read", { path });
            expect(yield* read("conventions.md")).toMatchObject({ content: "Tabs, not spaces." });
            for (const path of [
              "private/plans.md",
              "people.private.md",
              "deploy-token.md",
              "api-keys.md",
              "notes.md",
            ]) {
              const refused = yield* read(path).pipe(Effect.flip);
              expect(refused.message, path).toContain("No memory file");
            }
            expect(yield* session.callTool("memory_read", { path: "notes.md" })).toMatchObject({
              content: expect.stringContaining("Not for workers."),
            });
          }),
        );
      }),
    SLOW,
  );

  it.effect(
    "[16] refuses a worker's memory read through a symlink standing in a folder above the file",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const { session, workspaceId } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "reader" });
            yield* completeTurn(worker.session);
            yield* session.callTool("memory_write", { path: "topics/ok.md", content: "Fine." });
            const root = nodePath.join(world.dir, "memory", workspaceId);
            const version = readFileSync(nodePath.join(root, "CURRENT"), "utf8").trim();
            const versionDir = nodePath.join(root, "versions", version);
            // Another workspace's memory, and a folder of this one swapped for a link to it.
            const elsewhere = nodePath.join(world.dir, "memory", "other-workspace", "secrets");
            mkdirSync(elsewhere, { recursive: true });
            writeFileSync(nodePath.join(elsewhere, "ok.md"), "Another workspace's memory.");
            rmSync(nodePath.join(versionDir, "topics"), { recursive: true });
            symlinkSync(elsewhere, nodePath.join(versionDir, "topics"));
            const refused = yield* worker.session
              .callTool("memory_read", { path: "topics/ok.md" })
              .pipe(Effect.flip);
            expect(refused.message).not.toContain("Another workspace");
            expect(listed(yield* worker.session.callTool("memory_list", {}))).not.toContain(
              "topics/ok.md",
            );
          }),
        );
      }),
    SLOW,
  );
});

/**
 * [16], as the race: a folder of the memory tree is swapped for a link to another workspace's memory
 * after the read has walked to it and before it opens the file. Worker reads go through the anchored
 * tree (`memory.readForWorker`), which holds each folder it walked by its fd, so the swap can't lead
 * the read elsewhere: it reads the file it anchored, or fails. The ordinary tree checks the path,
 * then opens it again by name, which is the gap the review found.
 */
it("[16] a worker's anchored memory read can't be led into another workspace by a folder swapped mid-read", async () => {
  const dir = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "gram-memory-race-")));
  try {
    mkdirSync(nodePath.join(dir, "w1", "topics"), { recursive: true });
    writeFileSync(nodePath.join(dir, "w1", "topics", "ok.md"), "This workspace's memory.");
    const elsewhere = nodePath.join(dir, "w2", "secrets");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(nodePath.join(elsewhere, "ok.md"), "Another workspace's memory.");
    const swap = () =>
      Effect.sync(() => {
        renameSync(nodePath.join(dir, "w1", "topics"), nodePath.join(dir, "w1", "moved"));
        symlinkSync(elsewhere, nodePath.join(dir, "w1", "topics"));
      });
    const read = await Effect.runPromise(
      anchoredRequest<string>(
        dir,
        { op: "read", workspaceId: "w1", rel: "topics/ok.md", within: "", maxBytes: 1024 },
        { boundary: (phase) => (phase === "anchored" ? swap() : Effect.void) },
      ).pipe(Effect.exit),
    );
    if (read._tag === "Success") expect(read.value).toBe("This workspace's memory.");
    expect(JSON.stringify(read)).not.toContain("Another workspace");
    // And a link already standing in an ancestor is refused outright.
    const linked = await Effect.runPromise(
      anchoredRequest<string>(dir, {
        op: "read",
        workspaceId: "w1",
        rel: "topics/ok.md",
        within: "",
        maxBytes: 1024,
      }).pipe(Effect.exit),
    );
    expect(linked._tag).toBe("Failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
