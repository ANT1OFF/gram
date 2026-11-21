// A joined machine's host reaches only the repository each of its clones was made for: none of
// its git that reaches a clone's origin follows an origin rewritten to another repository.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  guardOrigins,
  Proc,
  ProcLive,
  type ProcShape,
  ProcTimeout,
  pushWip,
  wipRef,
  type Worktrees,
} from "@gram/git";
import * as Effect from "effect/Effect";
import { hasGit, makeRepo, removeDir, run, tempDir } from "../git/test-repo.ts";
import { checksOn } from "./checks.ts";
import { cloneWorktrees } from "./clone-worktrees.ts";
import { hostOriginGuard } from "./origin-guard.ts";
import { cloneFolderOf, reposOn } from "./repos.ts";

const URL = "https://github.com/acme/web.git";
const ELSEWHERE = "https://github.invalid/someone/private.git";
const MISSING = "0123456789abcdef0123456789abcdef01234567";

const live = Effect.runSync(
  Effect.gen(function* () {
    return yield* Proc;
  }).pipe(Effect.provide(ProcLive)),
);

/** Every git the host starts, by its arguments. */
const spawned: Array<ReadonlyArray<string>> = [];
const spy: ProcShape = {
  run: (bin, args, options) => {
    if (bin === "git") spawned.push(args);
    return live.run(bin, args, options);
  },
};
const fetchedOrigin = () =>
  spawned.some(
    (args) => (args.includes("fetch") || args.includes("push")) && args.includes("origin"),
  );

let root = "";
let clones = "";
let clone = "";
let release: (() => void) | undefined;

beforeEach(() => {
  spawned.length = 0;
  root = tempDir();
  clones = join(root, "clones");
  const folder = cloneFolderOf(URL);
  if ("error" in folder) throw new Error(folder.error);
  clone = join(clones, folder.folder);
  mkdirSync(dirname(clone), { recursive: true });
  // `makeRepo` makes `<dir>/repo`; the clone is the folder the host names for its repository.
  const made = makeRepo(root);
  run(root, "clone", "-q", made, clone);
  run(clone, "remote", "set-url", "origin", URL);
  release = guardOrigins(hostOriginGuard(clones));
});

afterEach(() => {
  release?.();
  removeDir(root);
});

const head = () => run(clone, "rev-parse", "HEAD").trim();
const guard = (dir: string, proc: ProcShape = live) =>
  hostOriginGuard(clones)(dir).pipe(Effect.provideService(Proc, proc), Effect.result);

const worktrees = {
  create: () => Effect.die("no worktree is made once the base can't be fetched"),
} as unknown as Worktrees["Service"];

describe.skipIf(!hasGit)("a joined machine's git, to a clone's rewritten origin", () => {
  it.effect("fetches no base for a new worktree", () =>
    Effect.gen(function* () {
      run(clone, "remote", "set-url", "origin", ELSEWHERE);
      const created = yield* cloneWorktrees(spy, worktrees)
        .create({ repoPath: clone, branch: "b", base: "origin/main" } as never)
        .pipe(Effect.result);
      expect(created._tag).toBe("Failure");
      expect(fetchedOrigin()).toBe(false);
    }),
  );

  it.effect("fetches no commit a check needs", () =>
    Effect.gen(function* () {
      run(clone, "remote", "set-url", "origin", ELSEWHERE);
      const checks = yield* checksOn(spy, join(root, "checks"), () => Effect.succeed({ ok: true }));
      const checked = yield* checks.run({
        id: "c-1",
        path: clone,
        head: head(),
        base: MISSING,
        command: "true",
        timeoutMs: 10_000,
      });
      expect(checked.ok).toBe(false);
      expect(fetchedOrigin()).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("pushes no work-in-progress snapshot", () =>
    Effect.gen(function* () {
      run(clone, "remote", "set-url", "origin", ELSEWHERE);
      const snapshot = { ref: wipRef("t-1"), commit: head(), head: head(), uncommitted: false };
      const pushed = yield* pushWip(clone, snapshot, "origin").pipe(
        Effect.provideService(Proc, spy),
        Effect.result,
      );
      expect(pushed._tag).toBe("Failure");
      expect(fetchedOrigin()).toBe(false);
    }),
  );

  it.effect("doesn't refresh a clone whose origin git rewrites elsewhere", () =>
    Effect.gen(function* () {
      // The stored URL is the one asked for, so only where git really goes tells them apart.
      run(
        clone,
        "config",
        "url.https://github.invalid/someone/.insteadOf",
        "https://github.com/acme/",
      );
      yield* reposOn(spy, clones).ensure(URL).pipe(Effect.result);
      expect(fetchedOrigin()).toBe(false);
    }),
  );

  it.effect("passes the same repository by another transport", () =>
    Effect.gen(function* () {
      run(clone, "config", "remote.origin.pushurl", "git@github.com:acme/web.git");
      expect((yield* guard(clone))._tag).toBe("Success");
    }),
  );

  it.effect("refuses a clone whose origin git can't read", () =>
    Effect.gen(function* () {
      const failing: ProcShape = {
        run: (bin, args, options) =>
          args.includes("get-url")
            ? Effect.fail(new ProcTimeout({ bin, message: "git timed out" }))
            : live.run(bin, args, options),
      };
      expect((yield* guard(clone, failing))._tag).toBe("Failure");
    }),
  );

  it.effect("only logs a rewrite in a folder of the person's own", () =>
    Effect.gen(function* () {
      const own = makeRepo(join(root, "own"));
      run(own, "remote", "add", "origin", URL);
      run(own, "config", "remote.origin.pushurl", ELSEWHERE);
      expect((yield* guard(own))._tag).toBe("Success");
    }),
  );
});
