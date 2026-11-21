// The default-branch watch (`MainWatchLive`) over a fake `gh`, a fake store and a fake orchestration,
// and its judgement: which commit is red, which green commit came before it, which pull requests a
// merge commit names, and what the orchestrator is told.
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  type Project,
  type ProjectId,
  type Thread,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { Proc, ProcSpawnError } from "@gram/git";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";
import { GhBudget } from "../github/budget.ts";
import { Orchestration } from "../orchestration/service.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { BranchHeads } from "./branch-heads.ts";
import {
  commitVerdicts,
  type MainRun,
  mainRedText,
  MainWatch,
  MainWatchConfig,
  MainWatchLive,
  prNumberOfMessage,
  readBranch,
} from "./main-watch.ts";

// Off unless a test turns it on: behind a GitHub route, each `gh` run carries a thread's handle.
const relay = vi.hoisted(() => ({ on: false }));
vi.mock("../embedding/github-relay.ts", async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  githubRelayed: () => relay.on,
  ghThreadEnv: (threadId: string) => (relay.on ? { GH_TOKEN: `gram-thread:${threadId}` } : {}),
}));

const run = (
  id: number,
  sha: string,
  at: string,
  conclusion: string | null,
  status = "completed",
): MainRun => ({
  id,
  name: `ci ${id}`,
  head_sha: sha,
  status,
  conclusion,
  html_url: `https://github.com/acme/shop/actions/runs/${id}`,
  created_at: at,
});

describe("commitVerdicts and readBranch", () => {
  it("judges each commit by its runs, newest first, and finds the green one before a red one", () => {
    const verdicts = commitVerdicts([
      run(5, "e", "2026-11-15T10:05:00Z", null, "in_progress"),
      run(4, "d", "2026-11-15T10:04:00Z", "failure"),
      run(3, "d", "2026-11-15T10:04:30Z", "success"),
      run(2, "c", "2026-11-15T10:03:00Z", "cancelled"),
      run(1, "b", "2026-11-15T10:02:00Z", "success"),
      run(0, "a", "2026-11-15T10:01:00Z", "failure"),
    ]);
    expect(verdicts.map((each) => [each.sha, each.verdict])).toEqual([
      ["e", "pending"],
      ["d", "red"],
      ["b", "green"],
      ["a", "red"],
    ]);
    expect(verdicts[1]?.failed).toEqual([
      { name: "ci 4", url: "https://github.com/acme/shop/actions/runs/4" },
    ]);
    const reading = readBranch(verdicts);
    expect(reading.newest?.sha).toBe("d");
    expect(reading.lastGreen).toBe("b");
  });

  it("reads a green newest commit as green, with nothing to narrow down", () => {
    const reading = readBranch(commitVerdicts([run(1, "b", "2026-11-15T10:02:00Z", "success")]));
    expect(reading).toEqual({ newest: { sha: "b", verdict: "green", failed: [] } });
  });
});

describe("prNumberOfMessage", () => {
  it("reads a squash title's number and a merge commit's, and nothing else", () => {
    expect(prNumberOfMessage("feat: mail (#21)\n\nbody (#3)")).toBe(21);
    expect(prNumberOfMessage("Merge pull request #22 from acme/branch")).toBe(22);
    expect(prNumberOfMessage("fix: a direct push")).toBeUndefined();
  });
});

describe("mainRedText", () => {
  it("names the failed runs and each merged PR with its worker", () => {
    expect(
      mainRedText({
        repo: "acme/shop",
        branch: "main",
        red: {
          sha: "d".repeat(40),
          verdict: "red",
          failed: [{ name: "e2e", url: "https://github.com/acme/shop/actions/runs/4" }],
        },
        lastGreen: "b".repeat(40),
        merged: [{ number: 21, worker: "Mail" }, { number: 22 }],
      }),
    ).toBe(
      'acme/shop main is red at ddddddd (failed: e2e). https://github.com/acme/shop/actions/runs/4 Merged since it was green at bbbbbbb: acme/shop#21 ("Mail"), acme/shop#22.',
    );
  });
});

interface Fake {
  readonly api: Map<string, string>;
  readonly calls: Array<string>;
  /** The handle each `gh` run carried, `""` for none. */
  readonly tokens?: Array<string>;
  readonly orchestrator?: string;
  readonly notes: Array<{ readonly note: string; readonly key?: string | undefined }>;
  charter: WorkspaceState["charter"];
}

const WORKSPACE = "ws-1" as WorkspaceId;
const PROJECT = "p-1" as ProjectId;
const RUNS = "repos/acme/shop/actions/runs?branch=main&event=push&per_page=50";

const layerOf = (f: Fake) =>
  MainWatchLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        GhBudget.layer,
        Layer.succeed(MainWatchConfig, { interval: Duration.hours(24) }),
        Layer.succeed(Proc, {
          run: (
            bin: string,
            args: ReadonlyArray<string>,
            options?: { readonly env?: Readonly<Record<string, string>> },
          ) =>
            Effect.suspend(() => {
              if (bin === "git") {
                return Effect.succeed({
                  status: 0,
                  stdout: "https://github.com/acme/shop.git\n",
                  stderr: "",
                  truncated: false,
                });
              }
              const path = args[1] ?? "";
              f.calls.push(path);
              f.tokens?.push(options?.env?.["GH_TOKEN"] ?? "");
              const body = f.api.get(path);
              if (body === undefined) {
                return Effect.fail(new ProcSpawnError({ bin: "gh", message: "gh: not found" }));
              }
              return Effect.succeed({ status: 0, stdout: body, stderr: "", truncated: false });
            }),
        } as unknown as Proc["Service"]),
        Layer.succeed(BranchHeads, {
          defaultBranch: () => Effect.succeed("main"),
          head: () => Effect.succeed(undefined),
        }),
        Layer.succeed(ThreadStore, {
          listProjects: Effect.succeed([
            { id: PROJECT, root: "/repos/shop", name: "shop", bookmarked: false } as Project,
          ]),
          listThreads: Effect.succeed([
            {
              id: "t-mail",
              title: "Mail",
              workspaceId: WORKSPACE,
              boundPr: { repo: "acme/shop", number: 21 },
            } as unknown as Thread,
          ]),
        } as unknown as ThreadStore["Service"]),
        Layer.succeed(Orchestration, {
          listWorkspaces: Effect.sync(() => [
            {
              workspace: {
                id: WORKSPACE,
                name: "shop",
                projectIds: [PROJECT],
                ...(f.orchestrator === undefined ? {} : { orchestratorThreadId: f.orchestrator }),
              },
              charter: f.charter,
            } as unknown as WorkspaceState,
          ]),
          addNote: (_workspaceId: WorkspaceId, note: string, _reason?: string, key?: string) =>
            Effect.sync(() => void f.notes.push({ note, key })),
        } as unknown as Orchestration["Service"]),
      ),
    ),
  );

const runsBody = (runs: ReadonlyArray<MainRun>) => JSON.stringify({ workflow_runs: runs });

describe("MainWatchLive", () => {
  it.effect("tells a red branch once with the PRs merged since green, then green again", () => {
    const f: Fake = {
      api: new Map(),
      calls: [],
      notes: [],
      charter: { ...DEFAULT_CHARTER, watchDefaultBranch: true },
    };
    f.api.set(
      RUNS,
      runsBody([
        run(2, "d".repeat(40), "2026-11-15T10:04:00Z", "failure"),
        run(1, "b".repeat(40), "2026-11-15T10:02:00Z", "success"),
      ]),
    );
    f.api.set(
      `repos/acme/shop/compare/${"b".repeat(40)}...${"d".repeat(40)}`,
      JSON.stringify({
        commits: [
          { sha: "c".repeat(40), commit: { message: "feat: mail (#21)" } },
          { sha: "d".repeat(40), commit: { message: "a direct push" } },
        ],
      }),
    );
    f.api.set(`repos/acme/shop/commits/${"d".repeat(40)}/pulls`, JSON.stringify([{ number: 22 }]));
    return Effect.gen(function* () {
      const watch = yield* MainWatch;
      yield* watch.poll;
      expect(f.notes).toHaveLength(1);
      expect(f.notes[0]?.key).toBe(`main-red:acme/shop:${"d".repeat(40)}`);
      expect(f.notes[0]?.note).toContain('acme/shop#21 ("Mail"), acme/shop#22');
      // The same red commit isn't told again.
      yield* watch.poll;
      expect(f.notes).toHaveLength(1);
      f.api.set(
        RUNS,
        runsBody([
          run(3, "f".repeat(40), "2026-11-15T10:06:00Z", "success"),
          run(2, "d".repeat(40), "2026-11-15T10:04:00Z", "failure"),
        ]),
      );
      yield* watch.poll;
      expect(f.notes.map((each) => each.note).at(-1)).toBe(
        "acme/shop main is green again at fffffff.",
      );
    }).pipe(Effect.provide(layerOf(f)), Effect.scoped);
  });

  it.effect("reads nothing for a workspace that hasn't turned it on", () => {
    const f: Fake = { api: new Map(), calls: [], notes: [], charter: DEFAULT_CHARTER };
    return Effect.gen(function* () {
      yield* (yield* MainWatch).poll;
      expect(f.calls).toEqual([]);
      expect(f.notes).toEqual([]);
    }).pipe(Effect.provide(layerOf(f)), Effect.scoped);
  });

  it.effect("reads behind a GitHub route as the workspace's orchestrator, or not at all", () => {
    const on = { ...DEFAULT_CHARTER, watchDefaultBranch: true };
    const f: Fake = { api: new Map(), calls: [], tokens: [], notes: [], charter: on };
    f.api.set(RUNS, runsBody([run(1, "b".repeat(40), "2026-11-15T10:02:00Z", "success")]));
    const orphan: Fake = { ...f, calls: [], tokens: [] };
    const led: Fake = { ...f, calls: [], tokens: [], orchestrator: "t-orch" };
    return Effect.gen(function* () {
      relay.on = true;
      yield* Effect.addFinalizer(() => Effect.sync(() => void (relay.on = false)));
      yield* MainWatch.pipe(
        Effect.flatMap((watch) => watch.poll),
        Effect.provide(layerOf(led)),
      );
      expect(led.calls).toContain(RUNS);
      expect(new Set(led.tokens)).toEqual(new Set(["gram-thread:t-orch"]));
      yield* MainWatch.pipe(
        Effect.flatMap((watch) => watch.poll),
        Effect.provide(layerOf(orphan)),
      );
      expect(orphan.calls).toEqual([]);
    }).pipe(Effect.scoped);
  });
});
