import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { Checkout, ProjectId, Thread, ThreadId, TurnId } from "@gram/contracts";
import { Checkpoints, markWorktreeUntrusted, readPermissionRules, settingsPath } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { asBackground } from "../github/budget.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { GitRefresh, gitPlatformTest } from "./platform.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-repo.ts";
import { GitTurnHooksLive } from "./turn-hooks.ts";

const TestLayer = GitTurnHooksLive.pipe(Layer.provideMerge(gitPlatformTest()));

const threadAt = (checkout: Checkout): Thread => ({
  id: "thread-1" as ThreadId,
  projectId: "project-1" as ProjectId,
  title: "t",
  userNamed: false,
  model: { agent: "claude", model: "default" },
  mode: "default",
  checkout,
  labels: [],
  pinned: false,
  parked: false,
  unread: false,
  createdAt: 0,
  lastActivityAt: 0,
});

describe.skipIf(!hasGit)("GitTurnHooksLive", () => {
  const dirs: Array<string> = [];
  const tmp = () => {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it.live("checkpoints each turn's start and end and requests refreshes", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      const hooks = yield* TurnHooks;
      const checkpoints = yield* Checkpoints;
      const refresh = yield* GitRefresh;
      const threadId = "thread-1" as ThreadId;
      const turnId = "turn-1" as TurnId;

      yield* hooks.onTurnStart(threadId, turnId, repo);
      write(nodePath.join(repo, "tracked.txt"), "edited by bash\n");
      yield* hooks.onTurnEnd(threadId, turnId, repo, "completed", true);
      expect(yield* checkpoints.list(repo, threadId)).toEqual(["turn-1", "turn-1.end"]);
      const between = yield* checkpoints.diffBetween(
        repo,
        "refs/gram/checkpoints/thread-1/turn-1",
        "refs/gram/checkpoints/thread-1/turn-1.end",
      );
      expect(between.files.map((f) => f.path)).toEqual(["tracked.txt"]);
      expect(run(repo, "diff", "--cached", "--name-only")).toBe("");
      expect(yield* Queue.take(refresh.requests)).toEqual({
        cwd: repo,
        remote: true,
        priority: "interactive",
      });

      yield* hooks.onFilesChanged(threadId, repo);
      expect(yield* Queue.take(refresh.requests)).toEqual({
        cwd: repo,
        remote: false,
        priority: "interactive",
      });

      // A turn that only edited files asks GitHub nothing; a push asks as it finishes, and has the
      // checkout followed closely while CI starts.
      yield* hooks.onTurnEnd(threadId, turnId, repo, "completed", false);
      expect(yield* Queue.take(refresh.requests)).toEqual({
        cwd: repo,
        remote: false,
        priority: "interactive",
      });
      yield* hooks.onRemoteCommand(threadId, repo);
      expect(yield* Queue.take(refresh.requests)).toEqual({
        cwd: repo,
        remote: true,
        expectChange: true,
        priority: "interactive",
      });
      // The queue is drained by another fiber, so who asked travels with the request.
      yield* asBackground(hooks.onFilesChanged(threadId, repo));
      expect(yield* Queue.take(refresh.requests)).toMatchObject({ priority: "background" });

      yield* hooks.onTurnStart(threadId, "turn-2" as TurnId, tmp());
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("seeds a followed worktree only when it and the thread are trusted", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      const hooks = yield* TurnHooks;
      write(settingsPath(repo), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }));
      const add = (name: string) => {
        const dir = nodePath.join(nodePath.dirname(repo), name);
        run(repo, "worktree", "add", "-q", "-b", name, dir);
        return dir;
      };
      const fork = add("pr-7-feature");
      yield* markWorktreeUntrusted(fork);
      const own = add("own");
      const other = add("other");
      const main = threadAt({ kind: "main", path: repo, branch: "main" });

      // Someone else's worktree is followed as untrusted and given none of the root's rules.
      expect(yield* hooks.resolveCwd(main, fork, true)).toEqual({
        kind: "worktree",
        path: fork,
        branch: "pr-7-feature",
        repoRoot: repo,
        trust: "untrusted",
      });
      expect(readPermissionRules(fork).allow).toEqual([]);
      // The user's own is seeded, as before.
      expect(yield* hooks.resolveCwd(main, own, true)).toMatchObject({ path: own });
      expect(readPermissionRules(own).allow).toEqual(["Bash(npm test)"]);
      // A thread working on someone else's tree seeds nothing anywhere it goes.
      const untrusted = threadAt({
        kind: "worktree",
        path: fork,
        branch: "pr-7-feature",
        repoRoot: repo,
        trust: "untrusted",
      });
      expect(yield* hooks.resolveCwd(untrusted, other, true)).toMatchObject({ path: other });
      expect(readPermissionRules(other).allow).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
