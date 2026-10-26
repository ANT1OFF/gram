import { afterAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as fs from "node:fs";
import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { eventually, hasGit, makeRepo, removeDir, tempDir } from "../git/test-repo.ts";
import { GitTurnHooksLive } from "../git/turn-hooks.ts";
import { ServerCore } from "../http/server.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentAdapter, FakeAgentControl } from "../runtime/fake-agent.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { AppToolRegistry } from "./registry.ts";

const TestLayer = ServerCore.pipe(
  Layer.provideMerge(FakeAgentAdapter),
  Layer.provideMerge(GitTurnHooksLive),
  Layer.provideMerge(gitPlatformTest()),
  Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
  Layer.orDie,
);

describe.skipIf(!hasGit)("move_to_worktree", () => {
  // Deleted once the layer has shut down: on Windows a live checkout watcher holds the tree.
  const dirs: Array<string> = [];
  afterAll(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it.live(
    "creates the worktree, moves the thread, and reopens the session there after the turn",
    () =>
      Effect.gen(function* () {
        const dir = tempDir();
        dirs.push(dir);
        const repo = makeRepo(dir);
        const runtimes = yield* ThreadRuntimes;
        const registry = yield* AppToolRegistry;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const publisher = yield* GitStatePublisher;

        const thread = yield* runtimes.create({
          projectRoot: repo,
          checkout: { kind: "main", path: repo },
          input: { text: "move yourself" },
        });
        // As `thread.close` does: the worktree is unwatched before it's deleted.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const current = yield* store.getThread(thread.id);
            const release = yield* publisher.hold(current.checkout.path);
            yield* runtimes
              .close(thread.id, { removeWorktree: { force: true } })
              .pipe(Effect.ensuring(release));
          }).pipe(Effect.ignore),
        );
        const session = yield* eventually(
          "the first send",
          fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );

        const tool = registry
          .forThread(thread.id)
          .find((t) => t.descriptor.name === "move_to_worktree");
        expect(yield* tool!.describe!({ branch: "feat-move", base: "main" })).toBe(
          "Move this thread into a worktree on feat-move, from main",
        );
        const result = yield* tool!.run({ branch: "feat-move" });
        const moved = yield* store.getThread(thread.id);
        expect(moved.checkout).toMatchObject({
          kind: "worktree",
          branch: "feat-move",
          repoRoot: repo,
        });
        expect(result).toEqual({ moved: true, path: moved.checkout.path, branch: "feat-move" });
        expect(fs.existsSync(moved.checkout.path)).toBe(true);
        expect(fake.sessions).toHaveLength(1);

        yield* session.completeTurn();
        const reopened = yield* eventually(
          "the reopened session",
          Effect.sync(() => fake.sessions.length === 2 && fake.sessions[1]),
        );
        expect(reopened.options.cwd).toBe(moved.checkout.path);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
