import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as fs from "node:fs";
import { ServerConfig } from "../../config.ts";
import { gitPlatformTest } from "../../git/platform.ts";
import { hasGit, makeRepo, removeDir, tempDir } from "../../git/test-repo.ts";
import { GitTurnHooksLive } from "../../git/turn-hooks.ts";
import { ServerCore } from "../../http/server.ts";
import { FakeAgentAdapter } from "../../runtime/fake-agent.ts";
import { captureLogs } from "@gram/agents/testing/logs";
import { TEST_CONFIG } from "../../runtime/test-harness.ts";
import { threadHandlers } from "./threads.ts";

const TestLayer = ServerCore.pipe(
  Layer.provideMerge(FakeAgentAdapter),
  Layer.provideMerge(GitTurnHooksLive),
  Layer.provideMerge(gitPlatformTest()),
  Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
  Layer.orDie,
  Layer.provideMerge(captureLogs({ printWarnings: true }).layer),
);

const tempRepo = Effect.gen(function* () {
  const dir = tempDir();
  yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
  return makeRepo(dir);
});

describe.skipIf(!hasGit)("thread.create with other repositories", () => {
  it.layer(TestLayer)((t) => {
    t.effect("gives a new worktree's thread one in each other repository, on its branch", () =>
      Effect.gen(function* () {
        const handlers = yield* threadHandlers;
        const api = yield* tempRepo;
        const web = yield* tempRepo;
        const thread = yield* handlers["thread.create"]({
          projectRoot: api,
          checkout: { kind: "newWorktree", branch: "feat/both" },
          alsoIn: [web, api],
        });
        expect(thread.checkout).toMatchObject({ kind: "worktree", branch: "feat/both" });
        // The one it works in is never made twice.
        expect(thread.extraCheckouts).toHaveLength(1);
        const [extra] = thread.extraCheckouts ?? [];
        expect(extra).toMatchObject({ kind: "worktree", branch: "feat/both", repoRoot: web });
        expect(fs.existsSync(extra!.path)).toBe(true);
        expect(thread.additionalDirectories).toEqual([extra!.path]);
      }),
    );

    t.effect("gives a thread in a folder as it is the other folders as they are", () =>
      Effect.gen(function* () {
        const handlers = yield* threadHandlers;
        const api = yield* tempRepo;
        const web = yield* tempRepo;
        const thread = yield* handlers["thread.create"]({
          projectRoot: api,
          checkout: { kind: "current" },
          alsoIn: [web],
        });
        expect(thread.extraCheckouts).toBeUndefined();
        expect(thread.additionalDirectories).toEqual([web]);
      }),
    );

    t.effect("makes nothing when another repository's folder isn't there", () =>
      Effect.gen(function* () {
        const handlers = yield* threadHandlers;
        const api = yield* tempRepo;
        const missing = yield* handlers["thread.create"]({
          projectRoot: api,
          checkout: { kind: "newWorktree", branch: "feat/none" },
          alsoIn: [`${api}-nowhere`],
        }).pipe(Effect.flip);
        expect(missing).toMatchObject({ _tag: "NotFound" });
        expect(fs.existsSync(`${api}/.worktrees`)).toBe(false);
      }),
    );
  });
});
