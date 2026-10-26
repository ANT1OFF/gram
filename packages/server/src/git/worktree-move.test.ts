import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { Checkout, Thread } from "@gram/contracts";
import { readPermissionRules } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TurnHooks } from "../runtime/hooks.ts";
import { gitPlatformTest } from "./platform.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-repo.ts";
import { GitTurnHooksLive } from "./turn-hooks.ts";

const TestLayer = GitTurnHooksLive.pipe(Layer.provideMerge(gitPlatformTest()));

const threadOn = (checkout: Checkout, currentCheckout?: Checkout) =>
  ({ checkout, ...(currentCheckout === undefined ? {} : { currentCheckout }) }) as Thread;

describe.skipIf(!hasGit)("resolveCwd (follow worktree moves)", () => {
  const dirs: Array<string> = [];
  const tmp = () => {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  const setup = () => {
    const repo = makeRepo(tmp());
    const worktree = nodePath.join(repo, ".worktrees", "feat");
    run(repo, "worktree", "add", "-q", "-b", "feat", worktree);
    fs.mkdirSync(nodePath.join(worktree, "src"));
    return { repo, worktree };
  };

  it.live("follows another worktree of the same repo and returns to the launch checkout", () =>
    Effect.gen(function* () {
      const hooks = yield* TurnHooks;
      const { repo, worktree } = setup();
      const launch = threadOn({ kind: "main", path: repo });
      const followed: Checkout = {
        kind: "worktree",
        path: worktree,
        branch: "feat",
        repoRoot: repo,
      };

      expect(yield* hooks.resolveCwd(launch, worktree, true)).toEqual(followed);
      expect(yield* hooks.resolveCwd(launch, nodePath.join(worktree, "src"), true)).toEqual(
        followed,
      );
      expect(yield* hooks.resolveCwd(launch, repo, true)).toBeUndefined();

      const moved = threadOn({ kind: "main", path: repo }, followed);
      expect(yield* hooks.resolveCwd(moved, worktree, true)).toBeUndefined();
      expect(yield* hooks.resolveCwd(moved, repo, true)).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("stops following when the setting is off or the worktree is gone", () =>
    Effect.gen(function* () {
      const hooks = yield* TurnHooks;
      const { repo, worktree } = setup();
      const followed: Checkout = { kind: "worktree", path: worktree, repoRoot: repo };

      expect(
        yield* hooks.resolveCwd(threadOn({ kind: "main", path: repo }), worktree, false),
      ).toBeUndefined();
      expect(
        yield* hooks.resolveCwd(threadOn({ kind: "main", path: repo }, followed), worktree, false),
      ).toBeNull();

      const gone = { ...followed, path: nodePath.join(repo, ".worktrees", "removed") };
      expect(
        yield* hooks.resolveCwd(threadOn({ kind: "main", path: repo }, gone), worktree, true),
      ).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("ignores other repos and folders outside git", () =>
    Effect.gen(function* () {
      const hooks = yield* TurnHooks;
      const { repo } = setup();
      const other = makeRepo(tmp());
      const launch = threadOn({ kind: "main", path: repo });
      expect(yield* hooks.resolveCwd(launch, other, true)).toBeUndefined();
      expect(yield* hooks.resolveCwd(launch, tmp(), true)).toBeUndefined();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("seeds an entered worktree with the repo root's permission rules", () =>
    Effect.gen(function* () {
      const hooks = yield* TurnHooks;
      const { repo, worktree } = setup();
      write(
        nodePath.join(repo, ".claude", "settings.local.json"),
        JSON.stringify({ permissions: { allow: ["Bash(pnpm test:*)"] } }),
      );
      yield* hooks.resolveCwd(threadOn({ kind: "main", path: repo }), worktree, true);
      expect(readPermissionRules(worktree).allow).toEqual(["Bash(pnpm test:*)"]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
