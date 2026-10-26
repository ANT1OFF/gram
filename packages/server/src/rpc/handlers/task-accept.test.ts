import { describe, expect, it } from "@effect/vitest";
import type { TaskChipData, TaskId, Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { ServerConfig } from "../../config.ts";
import { gitPlatformTest } from "../../git/platform.ts";
import { hasGit, makeRepo, removeDir, run, tempDir } from "../../git/test-repo.ts";
import { GitTurnHooksLive } from "../../git/turn-hooks.ts";
import { ServerCore } from "../../http/server.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { FakeAgentAdapter } from "../../runtime/fake-agent.ts";
import { TEST_CONFIG } from "../../runtime/test-harness.ts";
import { threadHandlers } from "./threads.ts";

const TestLayer = ServerCore.pipe(
  Layer.provideMerge(FakeAgentAdapter),
  Layer.provideMerge(GitTurnHooksLive),
  Layer.provideMerge(gitPlatformTest()),
  Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
  Layer.orDie,
);

/** A thread on a repo whose checkout has moved on from `main`, offering `chip`. */
const offering = (chip: Partial<TaskChipData>) =>
  Effect.gen(function* () {
    const dir = tempDir();
    yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
    const repo = makeRepo(dir);
    run(repo, "switch", "-q", "-c", "feat/parent");
    fs.writeFileSync(nodePath.join(repo, "parent.txt"), "the parent's unmerged work\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-qm", "parent work");

    const store = yield* ThreadStore;
    const project = yield* store.ensureProject({ root: repo, name: "repo" });
    const parent: Thread = {
      id: randomUUID() as ThreadId,
      projectId: project.id,
      title: "Parent",
      userNamed: true,
      model: { agent: "claude", model: "haiku" },
      mode: "acceptEdits",
      // Recorded when the thread was made; the session has switched branches since.
      checkout: { kind: "main", path: repo, branch: "main" },
      labels: [],
      pinned: false,
      parked: false,
      unread: false,
      createdAt: 0,
      lastActivityAt: 0,
    };
    yield* store.insertThread(parent);
    const task: TaskChipData = {
      id: randomUUID() as TaskId,
      title: "Follow up",
      prompt: "do the follow-up",
      status: "offered",
      ...chip,
    };
    yield* store.putTask(parent.id, "m-chip", task);
    return { repo, parent, task, head: run(repo, "rev-parse", "HEAD").trim() };
  });

describe.skipIf(!hasGit)("task.accept", () => {
  it.live("starts the task in a worktree of its own, on the parent's commits", () =>
    Effect.gen(function* () {
      const { repo, parent, task, head } = yield* offering({});
      const handlers = yield* threadHandlers;
      const started = yield* handlers["task.accept"]({ threadId: parent.id, taskId: task.id });

      expect(started.checkout.kind).toBe("worktree");
      expect(fs.realpathSync(started.checkout.path)).not.toBe(fs.realpathSync(repo));
      // From where the parent stands, not from `main` and not from the branch it was created on.
      expect(run(started.checkout.path, "rev-parse", "HEAD").trim()).toBe(head);
      expect(fs.existsSync(nodePath.join(started.checkout.path, "parent.txt"))).toBe(true);
      // And the parent's own checkout was left where it was.
      expect(run(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat/parent");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("shares the parent's checkout only when the chip asks to", () =>
    Effect.gen(function* () {
      const { repo, parent, task } = yield* offering({ checkout: "current" });
      const handlers = yield* threadHandlers;
      const started = yield* handlers["task.accept"]({ threadId: parent.id, taskId: task.id });
      expect(fs.realpathSync(started.checkout.path)).toBe(fs.realpathSync(repo));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("shares the checkout the parent has moved to, not the one it was created in", () =>
    Effect.gen(function* () {
      const { repo, parent, task } = yield* offering({ checkout: "current" });
      const moved = nodePath.join(nodePath.dirname(repo), "moved");
      run(repo, "worktree", "add", "-q", "-b", "feat/moved", moved);
      const store = yield* ThreadStore;
      yield* store.updateThread(parent.id, (t) => ({
        ...t,
        currentCheckout: { kind: "worktree", path: moved, repoRoot: repo, branch: "feat/moved" },
      }));

      const handlers = yield* threadHandlers;
      const started = yield* handlers["task.accept"]({ threadId: parent.id, taskId: task.id });
      expect(fs.realpathSync(started.checkout.path)).toBe(fs.realpathSync(moved));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("refuses a base that isn't there, rather than branching from somewhere else", () =>
    Effect.gen(function* () {
      const { repo, parent, task } = yield* offering({ base: "origin/mian" });
      const handlers = yield* threadHandlers;
      const store = yield* ThreadStore;
      const before = (yield* store.listThreads).length;
      const error = yield* handlers["task.accept"]({ threadId: parent.id, taskId: task.id }).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({ _tag: "InvalidState" });
      expect(error.message).toContain("origin/mian");
      // Nothing was made, and the chip can still be accepted once it names a real base.
      expect((yield* store.listThreads).length).toBe(before);
      expect(run(repo, "worktree", "list").trim().split("\n")).toHaveLength(1);
      expect((yield* store.getTask(parent.id, task.id)).task.status).toBe("offered");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("branches from what a base names where the parent is, not at the project root", () =>
    Effect.gen(function* () {
      // `HEAD` names a different commit in every worktree.
      const { repo, parent, task } = yield* offering({ base: "HEAD" });
      const moved = nodePath.join(nodePath.dirname(repo), "moved");
      run(repo, "worktree", "add", "-q", "-b", "feat/moved", moved);
      fs.writeFileSync(nodePath.join(moved, "moved.txt"), "only where the parent moved to\n");
      run(moved, "add", "-A");
      run(moved, "commit", "-qm", "moved work");
      const store = yield* ThreadStore;
      yield* store.updateThread(parent.id, (t) => ({
        ...t,
        currentCheckout: { kind: "worktree", path: moved, repoRoot: repo, branch: "feat/moved" },
      }));

      const handlers = yield* threadHandlers;
      const started = yield* handlers["task.accept"]({ threadId: parent.id, taskId: task.id });
      expect(run(started.checkout.path, "rev-parse", "HEAD").trim()).toBe(
        run(moved, "rev-parse", "HEAD").trim(),
      );
      expect(fs.existsSync(nodePath.join(started.checkout.path, "moved.txt"))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("branches from the base a chip names", () =>
    Effect.gen(function* () {
      const { parent, task } = yield* offering({ base: "main", branch: "fix/independent" });
      const handlers = yield* threadHandlers;
      const started = yield* handlers["task.accept"]({ threadId: parent.id, taskId: task.id });
      expect(started.checkout.branch).toBe("fix/independent");
      expect(fs.existsSync(nodePath.join(started.checkout.path, "parent.txt"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
