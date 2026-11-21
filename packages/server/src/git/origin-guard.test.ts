// Behind a GitHub route, none of the server's git that reaches a folder's origin follows an origin
// rewritten to another repository: each path runs through `remoteGit`, which asks the guard first.
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import type { Project, Thread } from "@gram/contracts";
import {
  fetchOriginBranch,
  fetchWip,
  guardOrigins,
  originBaseRef,
  Proc,
  ProcLive,
  pushCurrentBranch,
  pushWip,
  remoteGit,
  wipRef,
} from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";
import * as nodePath from "node:path";
import { cloneIdentityOf } from "../host/repos.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { checked, fixture, layer } from "./local-checks-fixture.ts";
import { storeOriginGuard } from "./origin-guard.ts";
import { hasGit, makeRepo, removeDirStrict, run, tempDir } from "./test-repo.ts";

const relay = vi.hoisted(() => ({ on: true }));
vi.mock("../embedding/github-relay.ts", async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  githubRelayed: () => relay.on,
}));

/** Every git the code under test starts, by its arguments. */
const spawned: Array<ReadonlyArray<string>> = [];
const SpyProc = Layer.effect(
  Proc,
  Effect.gen(function* () {
    const live = yield* Proc;
    return {
      run: (bin, args, options) => {
        if (bin === "git") spawned.push(args);
        return live.run(bin, args, options);
      },
    };
  }),
).pipe(Layer.provide(ProcLive));

const NETWORK = new Set(["fetch", "push", "ls-remote", "pull"]);
const reachedRemote = () => spawned.some((args) => args.some((arg) => NETWORK.has(arg)));

let dirs: Array<string> = [];
let release: (() => void) | undefined;
let repo = "";
let worktree = "";
let project: Project;

beforeEach(() => {
  relay.on = true;
  spawned.length = 0;
  const tmp = tempDir();
  dirs.push(tmp);
  repo = makeRepo(tmp);
  run(repo, "remote", "add", "origin", "https://github.com/acme/web.git");
  project = {
    id: "p-1",
    name: "web",
    root: repo,
    originIdentity: cloneIdentityOf("https://github.com/acme/web.git"),
  } as unknown as Project;
  worktree = `${tmp}/wt`;
  run(repo, "worktree", "add", "-q", "-b", "side", worktree);
  // An agent working there points origin at a repository the project was never given.
  run(repo, "remote", "set-url", "origin", "https://github.invalid/someone/private.git");
  const store = {
    listProjects: Effect.succeed([project]),
    listThreads: Effect.succeed([] as ReadonlyArray<Thread>),
  };
  release = guardOrigins(storeOriginGuard(store));
});

afterEach(() => {
  release?.();
  for (const dir of dirs) removeDirStrict(dir);
  dirs = [];
});

const head = () => run(repo, "rev-parse", "HEAD").trim();
const attempt = <A, E>(effect: Effect.Effect<A, E, Proc>) =>
  effect.pipe(Effect.provide(SpyProc), Effect.result);

describe.skipIf(!hasGit)("the server's git, behind a GitHub route, to a rewritten origin", () => {
  it.effect("fetches no origin branch (`fetchOriginBranch`, the rebase signal's fetch)", () =>
    Effect.gen(function* () {
      expect((yield* attempt(fetchOriginBranch(repo, "origin/main")))._tag).toBe("Failure");
      expect(reachedRemote()).toBe(false);
    }),
  );

  it.effect("fetches no base for a new branch (`originBaseRef`)", () =>
    Effect.gen(function* () {
      yield* attempt(originBaseRef(repo));
      expect(reachedRemote()).toBe(false);
    }),
  );

  it.effect("pushes no thread branch from a worktree of the project", () =>
    Effect.gen(function* () {
      expect((yield* attempt(pushCurrentBranch(worktree)))._tag).toBe("Failure");
      expect(reachedRemote()).toBe(false);
    }),
  );

  it.effect("pushes and fetches no work-in-progress snapshot", () =>
    Effect.gen(function* () {
      const snapshot = { ref: wipRef("t-1"), commit: head(), head: head(), uncommitted: false };
      expect((yield* attempt(pushWip(repo, snapshot, "origin")))._tag).toBe("Failure");
      expect((yield* attempt(fetchWip(worktree, "t-1", "origin")))._tag).toBe("Failure");
      expect(reachedRemote()).toBe(false);
    }),
  );

  it.live("fetches no commit a local check needs from origin", () =>
    Effect.gen(function* () {
      const { dir, repo: checked_, head: tip } = fixture();
      dirs.push(dir);
      run(checked_, "remote", "add", "origin", "https://github.com/acme/web.git");
      const missing = "0123456789abcdef0123456789abcdef01234567";
      const outcome = yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        // Registered with its origin as it was, then rewritten.
        run(checked_, "remote", "set-url", "origin", "https://github.invalid/someone/private.git");
        release?.();
        release = guardOrigins(storeOriginGuard(store));
        return yield* checked(checked_, tip, missing);
      }).pipe(
        Effect.provide(
          layer(
            nodePath.join(dir, "gram.db"),
            dir,
            () => Effect.succeed({ ok: true }),
            true,
            SpyProc,
          ),
        ),
      );
      expect(outcome?.status).not.toBe("passed");
      expect(spawned.some((args) => args.includes("fetch") && args.includes("origin"))).toBe(false);
    }),
  );

  it.effect("runs no other network git on origin either (`remoteGit`)", () =>
    Effect.gen(function* () {
      const out = yield* attempt(remoteGit(repo, ["ls-remote", "origin"]));
      expect(out._tag).toBe("Failure");
      expect(reachedRemote()).toBe(false);
    }),
  );

  it.effect("fetches as before without a route", () =>
    Effect.gen(function* () {
      relay.on = false;
      yield* attempt(fetchOriginBranch(repo, "origin/main"));
      expect(reachedRemote()).toBe(true);
    }),
  );
});
