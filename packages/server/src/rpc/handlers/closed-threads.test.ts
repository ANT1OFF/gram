import { describe, expect, it } from "@effect/vitest";
import { CLOSED_THREADS_LIMIT, type ProjectId, type Thread, type ThreadId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderError } from "../../fs/folders.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { RuntimeTestLayer, waitFor } from "../../runtime/test-harness.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import { closedThreadHandlers, makeClosedThreadHandlers } from "./closed-threads.ts";

const threadOf = (projectId: ProjectId, id: string, at = 0): Thread => ({
  id: id as ThreadId,
  projectId,
  title: `Thread ${id}`,
  userNamed: true,
  model: { agent: "claude", model: "haiku" },
  mode: "default",
  checkout: { kind: "main", path: tmpdir() },
  labels: [],
  pinned: false,
  parked: false,
  unread: false,
  createdAt: at,
  lastActivityAt: at,
});

describe("threads.closed", () => {
  it.effect("keeps a closed thread, marks what changed since, and takes the newest", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const handlers = yield* closedThreadHandlers;
      const projectRoot = tmpdir();
      const created = yield* runtimes.create({
        projectRoot,
        checkout: { kind: "main", path: projectRoot },
      });
      yield* waitFor("idle", runtimes.status(created.id).pipe(Effect.map((s) => s === "idle")));
      const thread = yield* store.getThread(created.id);
      yield* runtimes.close(thread.id);

      expect(yield* handlers["threads.closed.list"]()).toEqual([
        { thread, closedAt: expect.any(Number) },
      ]);

      // A later thread showing the same session, and one closed after it whose folder is gone.
      yield* store.insertThread({ ...thread, id: randomUUID() as ThreadId });
      const missing = {
        ...thread,
        id: randomUUID() as ThreadId,
        checkout: { kind: "main" as const, path: join(tmpdir(), `gram-gone-${randomUUID()}`) },
      };
      const { agentSessionId: _session, ...withoutSession } = missing;
      yield* store.rememberClosed(withoutSession, Date.now() + 1_000);

      const listed = yield* handlers["threads.closed.list"]();
      expect(listed.map((entry) => [entry.thread.id, entry.problem])).toEqual([
        [missing.id, "folderMissing"],
        [thread.id, "sessionOpen"],
      ]);
      expect(listed[1]?.openThreadId).toBeDefined();

      // Its folder gone, it opens all the same, cold, with what it was beyond its conversation.
      const back = yield* handlers["threads.closed.reopen"]();
      expect(back?.closed.problem).toBe("folderMissing");
      expect(back?.thread).toMatchObject({
        id: missing.id,
        checkout: missing.checkout,
        userNamed: false,
        labels: thread.labels,
      });
      expect(back?.membership).toBeUndefined();
      expect(yield* runtimes.status(missing.id)).toBe("cold");
      expect((yield* handlers["threads.closed.list"]()).map((e) => e.thread.id)).toEqual([
        thread.id,
      ]);

      // Its session shown elsewhere, that thread is the answer, and the entry goes.
      const shown = yield* handlers["threads.closed.reopen"]();
      expect(shown?.closed.problem).toBe("sessionOpen");
      expect(shown?.thread).toBeUndefined();
      expect(yield* handlers["threads.closed.list"]()).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps only the newest closed threads, and takes nothing when there are none", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const handlers = yield* closedThreadHandlers;
      expect(yield* handlers["threads.closed.reopen"]()).toBeNull();

      const project = yield* store.ensureProject({ root: tmpdir(), name: "tmp" });
      for (let i = 0; i < CLOSED_THREADS_LIMIT + 5; i++) {
        yield* store.rememberClosed(threadOf(project.id, `t-${i}`, i), i);
      }
      const listed = yield* store.listClosed;
      expect(listed).toHaveLength(CLOSED_THREADS_LIMIT);
      expect(listed[0]?.thread.id).toBe(`t-${CLOSED_THREADS_LIMIT + 4}`);
      expect(listed.at(-1)?.thread.id).toBe("t-5");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "marks only a folder that's definitely gone, and puts back one that fails to reopen",
    () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const project = yield* store.ensureProject({ root: tmpdir(), name: "tmp" });
        // What Windows reports while it finishes deleting a folder, or while antivirus holds it.
        const locked = yield* makeClosedThreadHandlers((path) =>
          Effect.fail(
            folderError(
              Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }),
              path,
              "win32",
            ),
          ),
        );
        yield* store.rememberClosed(threadOf(project.id, "t-older"), 1);
        yield* store.rememberClosed(threadOf(project.id, "t-locked"), 2);

        expect((yield* locked["threads.closed.list"]()).map((entry) => entry.problem)).toEqual([
          undefined,
          undefined,
        ]);
        const failed = yield* locked["threads.closed.reopen"]().pipe(Effect.flip);
        expect(failed._tag).toBe("InvalidState");
        expect((yield* store.listClosed).map((entry) => [entry.thread.id, entry.closedAt])).toEqual(
          [
            ["t-locked", 2],
            ["t-older", 1],
          ],
        );
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("drops a worker's extra worktree another thread holds from its grants too", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const handlers = yield* closedThreadHandlers;
      const project = yield* store.ensureProject({ root: tmpdir(), name: "tmp" });
      const taken = join(tmpdir(), `gram-extra-${randomUUID()}`);
      const readAlso = join(tmpdir(), "read-also");
      yield* store.insertThread({
        ...threadOf(project.id, "t-holder"),
        checkout: { kind: "worktree", path: taken },
      });
      yield* store.rememberClosed(
        {
          ...threadOf(project.id, "t-spanning"),
          extraCheckouts: [{ kind: "worktree", path: taken }],
          additionalDirectories: [taken, readAlso],
        },
        1,
      );
      const back = yield* handlers["threads.closed.reopen"]();
      expect(back?.thread?.extraCheckouts).toBeUndefined();
      expect(back?.thread?.additionalDirectories).toEqual([readAlso]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "two reopens at once take two entries, and an interrupted one puts its entry back",
    () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const handlers = yield* closedThreadHandlers;
        const project = yield* store.ensureProject({ root: tmpdir(), name: "tmp" });
        yield* store.rememberClosed(threadOf(project.id, "t-a"), 1);
        yield* store.rememberClosed(threadOf(project.id, "t-b"), 2);
        const both = yield* Effect.all(
          [handlers["threads.closed.reopen"](), handlers["threads.closed.reopen"]()],
          { concurrency: 2 },
        );
        expect(both.map((r) => r?.thread?.id).toSorted()).toEqual(["t-a", "t-b"]);

        // Interrupted while it checks the folder, after the entry left the list.
        yield* store.rememberClosed(threadOf(project.id, "t-stuck"), 3);
        const probing = yield* Deferred.make<void>();
        const hanging = yield* makeClosedThreadHandlers(() =>
          Deferred.succeed(probing, undefined).pipe(Effect.andThen(Effect.never)),
        );
        const fiber = yield* Effect.forkScoped(hanging["threads.closed.reopen"]());
        yield* Deferred.await(probing);
        expect(yield* store.listClosed).toEqual([]);
        yield* Fiber.interrupt(fiber);
        expect((yield* store.listClosed).map((e) => [e.thread.id, e.closedAt])).toEqual([
          ["t-stuck", 3],
        ]);
      }).pipe(Effect.scoped, Effect.provide(RuntimeTestLayer)),
  );
});
