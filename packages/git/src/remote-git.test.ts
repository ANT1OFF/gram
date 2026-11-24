import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProcLive } from "./proc.ts";
import { fetchOriginBranch } from "./refs.ts";
import { guardOrigins, pinnedArgs, positionalProblem, remoteGit } from "./remote-git.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";

const URLS = { fetch: "https://example.test/good.git", push: "https://example.test/push.git" };

describe("pinnedArgs", () => {
  it("names the checked URL and maps a branch as origin's refspec would", () => {
    expect(pinnedArgs(["fetch", "--quiet", "origin", "main"], URLS)).toEqual({
      args: ["fetch", "--quiet", URLS.fetch, "+refs/heads/main:refs/remotes/origin/main"],
      url: URLS.fetch,
    });
    expect(pinnedArgs(["-c", "a=b", "fetch", "origin"], URLS)?.args).toEqual([
      "-c",
      "a=b",
      "fetch",
      URLS.fetch,
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    const oid = "a".repeat(40);
    expect(pinnedArgs(["fetch", "origin", oid, "refs/pull/1/head:refs/x"], URLS)?.args).toEqual([
      "fetch",
      URLS.fetch,
      oid,
      "refs/pull/1/head:refs/x",
    ]);
  });

  it("pushes to the checked push URL with the refspecs as given", () => {
    expect(pinnedArgs(["push", "--quiet", "origin", "HEAD:refs/heads/x"], URLS)).toEqual({
      args: ["push", "--quiet", URLS.push, "HEAD:refs/heads/x"],
      url: URLS.push,
    });
  });

  it("can't pin git that names no remote, takes them all or isn't a fetch, push or ls-remote", () => {
    expect(pinnedArgs(["fetch"], URLS)).toBeUndefined();
    expect(pinnedArgs(["fetch", "--all"], URLS)).toBeUndefined();
    expect(pinnedArgs(["pull", "origin", "main"], URLS)).toBeUndefined();
    expect(pinnedArgs(["submodule", "update", "--init"], URLS)).toBeUndefined();
  });
});

describe("positionalProblem", () => {
  it("takes a remote, refs, URL or folder only after --end-of-options, none option-shaped", () => {
    for (const args of [
      ["fetch", "--quiet", "--end-of-options", "origin", "main"],
      ["-c", "a=b", "push", "--force-with-lease=x:y", "--end-of-options", "origin", "+a:b"],
      ["ls-remote", "--", "origin", "refs/heads/x"],
      ["clone", "--quiet", "--end-of-options", "https://example.test/r.git", "/tmp/r"],
      ["fetch", "--all", "--prune"],
      ["rev-parse", "HEAD"],
    ])
      expect(positionalProblem(args)).toBeUndefined();
    for (const args of [
      ["fetch", "--quiet", "origin", "main"],
      ["fetch", "--end-of-options", "origin", "--upload-pack=x"],
      ["push", "--end-of-options", "--receive-pack=x", "HEAD"],
      ["clone", "--", "-u", "/tmp/r"],
      ["fetch", "--depth", "1", "--end-of-options", "origin"],
    ])
      expect(positionalProblem(args)).toBeDefined();
  });

  it("pins the checked URL after --end-of-options", () => {
    expect(
      pinnedArgs(["fetch", "--quiet", "--end-of-options", "origin", "main"], URLS)?.args,
    ).toEqual([
      "fetch",
      "--quiet",
      "--end-of-options",
      URLS.fetch,
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
  });
});

describe.skipIf(!hasGit)("remoteGit with a guard that checked the URLs", () => {
  const dirs: Array<string> = [];
  let release: (() => void) | undefined;
  afterEach(() => {
    release?.();
    release = undefined;
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  /** A clone of bare `good`, and a bare `evil` with a different `main`. */
  const setup = () => {
    const root = tempDir();
    dirs.push(root);
    const bares = (name: string) => {
      const seed = makeRepo(nodePath.join(root, `${name}-seed`));
      write(nodePath.join(seed, `${name}.txt`), name);
      run(seed, "add", "-A");
      run(seed, "commit", "-qm", name);
      const bare = nodePath.join(root, `${name}.git`);
      run(root, "clone", "-q", "--bare", seed, bare);
      return { bare, tip: run(bare, "rev-parse", "main").trim() };
    };
    const good = bares("good");
    const evil = bares("evil");
    const work = nodePath.join(root, "work");
    run(root, "clone", "-q", good.bare, work);
    return { good, evil, work };
  };

  it.live("fetches the URL the guard checked though origin is rewritten meanwhile", () =>
    Effect.gen(function* () {
      const { good, evil, work } = setup();
      release = guardOrigins(() =>
        Effect.sync(() => {
          run(work, "config", "remote.origin.url", evil.bare);
          return { fetch: good.bare, push: good.bare };
        }),
      );
      yield* fetchOriginBranch(work, "origin/main");
      expect(run(work, "rev-parse", "refs/remotes/origin/main").trim()).toBe(good.tip);
      expect(run(work, "rev-list", "--all")).not.toContain(evil.tip);
    }).pipe(Effect.provide(ProcLive)),
  );

  it.live("refuses a checked URL the repository's own config sends elsewhere", () =>
    Effect.gen(function* () {
      const { good, evil, work } = setup();
      release = guardOrigins(() => Effect.succeed({ fetch: good.bare, push: good.bare }));
      for (const [key, value] of [
        [`url.${evil.bare}.insteadOf`, good.bare],
        [`remote.${good.bare}.url`, evil.bare],
      ] as const) {
        run(work, "config", key, value);
        const out = yield* remoteGit(work, ["fetch", "--quiet", "origin", "main"]).pipe(
          Effect.result,
        );
        expect([key, out._tag]).toEqual([key, "Failure"]);
        run(work, "config", "--unset", key);
      }
      expect(run(work, "rev-parse", "refs/remotes/origin/main").trim()).toBe(good.tip);
    }).pipe(Effect.provide(ProcLive)),
  );
});
