import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { GitState, PrStatus, Thread, ThreadId, WorkspaceId } from "@gram/contracts";
import { samePathKey } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { OpenPrs } from "../github/open-prs.ts";
import { gitPlatformTest } from "./platform.ts";
import { discoverPrsElsewhere, pickPrElsewhere, wantsPrElsewhere } from "./pr-elsewhere.ts";
import { hasGit, makeRepo, removeDir, run, tempDir } from "./test-repo.ts";

const open = (number: number, overrides: Partial<PrStatus> = {}): PrStatus => ({
  number,
  state: "OPEN",
  url: `https://github.com/acme/web/pull/${number}`,
  title: `PR ${number}`,
  isDraft: false,
  checks: "pending",
  headMatches: true,
  aheadOfPr: false,
  ...overrides,
});

const state = (overrides: Partial<GitState> = {}): GitState => ({
  repo: true,
  branch: "main",
  worktree: false,
  head: "abc",
  changesToken: "t",
  changedFiles: 0,
  behindBase: 0,
  aheadBase: 0,
  conflicts: false,
  ...overrides,
});

const thread = (id: string, path: string, extra: Partial<Thread> = {}): Thread =>
  ({ id: id as ThreadId, checkout: { kind: "main", path }, ...extra }) as unknown as Thread;

describe("pickPrElsewhere", () => {
  it("picks the newest open PR on another worktree", () => {
    const own = samePathKey("/repo");
    expect(
      pickPrElsewhere(own, [
        { worktreePath: "/repo", branch: "main", pr: open(99) },
        { worktreePath: "/repo/.worktrees/a", branch: "feat/a", pr: open(4) },
        {
          worktreePath: "/repo/.worktrees/b",
          branch: "feat/b",
          pr: open(9),
          threadId: "t-b" as ThreadId,
        },
        { worktreePath: "/repo/.worktrees/c", branch: "feat/c", pr: open(12, { state: "MERGED" }) },
        { worktreePath: "/repo/.worktrees/d", branch: "feat/d", pr: undefined },
      ]),
    ).toEqual({
      number: 9,
      title: "PR 9",
      url: "https://github.com/acme/web/pull/9",
      repo: "acme/web",
      branch: "feat/b",
      worktreePath: "/repo/.worktrees/b",
      threadId: "t-b",
    });
    expect(
      pickPrElsewhere(own, [{ worktreePath: "/repo", branch: "main", pr: open(1) }]),
    ).toBeUndefined();
  });
});

describe("wantsPrElsewhere", () => {
  const worktree = { kind: "worktree", path: "/repo/.worktrees/a", branch: "feat/a" } as const;
  const worker = {
    workspaceId: "w-1",
    spawnedBy: { threadId: "t-orch", feature: "a" },
    checkout: worktree,
  } as unknown as Thread;

  it("keeps the cue on an ordinary thread, wherever it sits", () => {
    expect(wantsPrElsewhere(thread("t-a", "/repo"), { branch: "main" })).toBe(true);
    expect(wantsPrElsewhere({ checkout: worktree }, { branch: "feat/a" })).toBe(true);
  });

  it("drops it on the orchestrator and a dream", () => {
    expect(wantsPrElsewhere(thread("t-o", "/repo", { role: "orchestrator" }), {})).toBe(false);
    expect(wantsPrElsewhere(thread("t-d", "/repo", { role: "dream" }), {})).toBe(false);
  });

  it("drops it on a worker in its own worktree on its own branch, and only there", () => {
    expect(wantsPrElsewhere(worker, { branch: "feat/a" })).toBe(false);
    const { spawnedBy: _gone, ...orphaned } = worker;
    expect(wantsPrElsewhere(orphaned, { branch: "feat/a" })).toBe(false);
    expect(wantsPrElsewhere(worker, { branch: "fix/other" })).toBe(true);
    const moved = { ...worker, currentCheckout: { kind: "worktree", path: "/repo/.worktrees/b" } };
    expect(wantsPrElsewhere(moved as Thread, { branch: "feat/b" })).toBe(true);
    expect(wantsPrElsewhere({ ...worker, checkout: { kind: "main", path: "/repo" } }, {})).toBe(
      true,
    );
  });
});

describe.skipIf(!hasGit)("discoverPrsElsewhere", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  const worktreesAndThreads = () => {
    const root = tempDir();
    dirs.push(root);
    const repo = makeRepo(root);
    const other = nodePath.join(root, "other");
    const tracked = nodePath.join(root, "tracked");
    run(repo, "worktree", "add", "-q", "-b", "feat/other", other);
    run(repo, "worktree", "add", "-q", "-b", "feat/tracked", tracked);
    const threads = [
      thread("t-main", repo),
      thread("t-bound", repo, { boundPr: { repo: "acme/web", number: 3, monitor: false } }),
      thread("t-tracked", tracked),
    ];
    const states = new Map([
      [samePathKey(repo), state()],
      [samePathKey(tracked), state({ branch: "feat/tracked", worktree: true })],
    ]);
    return { repo, other, tracked, threads, states };
  };

  it.effect("answers every untracked worktree of a repo from one open-PR list", () =>
    Effect.gen(function* () {
      const { repo, other, tracked, threads, states } = worktreesAndThreads();
      const asked: Array<string> = [];
      const FakeOpenPrs = Layer.succeed(OpenPrs, {
        list: (cwd) =>
          Effect.sync(() => {
            asked.push(samePathKey(cwd));
            return [
              {
                number: 9,
                title: "PR 9",
                url: "https://github.com/acme/web/pull/9",
                branch: "feat/other",
              },
              // A tracked worktree answers from its own state, never from the list.
              {
                number: 7,
                title: "PR 7",
                url: "https://github.com/acme/web/pull/7",
                branch: "feat/tracked",
              },
            ];
          }),
      });

      const found = yield* discoverPrsElsewhere(threads, (key) => states.get(key)).pipe(
        Effect.provide(gitPlatformTest({ openPrs: FakeOpenPrs })),
      );

      expect(found.get(samePathKey(repo))).toMatchObject({
        number: 9,
        repo: "acme/web",
        branch: "feat/other",
      });
      expect(samePathKey(found.get(samePathKey(repo))?.worktreePath ?? "")).toBe(
        samePathKey(other),
      );
      expect(found.get(samePathKey(tracked))).toMatchObject({ number: 9, branch: "feat/other" });
      expect(asked).toHaveLength(1);
    }),
  );

  it.effect("leaves a repo's cues alone while its open PRs can't be read", () =>
    Effect.gen(function* () {
      const { threads, states } = worktreesAndThreads();
      const found = yield* discoverPrsElsewhere(threads, (key) => states.get(key)).pipe(
        Effect.provide(gitPlatformTest()),
      );
      expect(found.size).toBe(0);
    }),
  );

  it.effect("looks nothing up for an orchestrator and its workers", () =>
    Effect.gen(function* () {
      const { repo, tracked, states } = worktreesAndThreads();
      let asked = 0;
      const FakeOpenPrs = Layer.succeed(OpenPrs, {
        list: () => Effect.sync(() => (asked++, [])),
      });
      const threads = [
        thread("t-orch", repo, {
          role: "orchestrator",
          workspaceId: "w-1" as WorkspaceId,
        }),
        thread("t-worker", tracked, {
          workspaceId: "w-1" as WorkspaceId,
          checkout: { kind: "worktree", path: tracked, branch: "feat/tracked" },
        }),
      ];
      const found = yield* discoverPrsElsewhere(threads, (key) => states.get(key)).pipe(
        Effect.provide(gitPlatformTest({ openPrs: FakeOpenPrs })),
      );
      expect(found.size).toBe(0);
      expect(asked).toBe(0);
    }),
  );

  it.effect("finds nothing to do when every checkout has a PR", () =>
    Effect.gen(function* () {
      const found = yield* discoverPrsElsewhere([thread("t-a", "/nowhere")], () =>
        state({ pr: open(1) }),
      ).pipe(Effect.provide(gitPlatformTest()));
      expect(found.size).toBe(0);
    }),
  );
});
