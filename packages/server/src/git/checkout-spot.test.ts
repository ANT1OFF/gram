// Behind an embedder's GitHub route, a checkout's own branch badge is read for a thread on it, and
// a checkout with no thread on it is not read at all: nothing goes out for nobody in particular.
import { afterEach, describe, expect, it } from "@effect/vitest";
import { GhCallEnv, Pr } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RuntimeTestLayer } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { gitPlatformTest } from "./platform.ts";
import { GitStatePublisher, GitStatePublisherLive } from "./publisher.ts";
import { hasGit, makeRepo, removeDir, tempDir } from "./test-repo.ts";
import { markGithubRelayed } from "../embedding/github-relay.ts";

markGithubRelayed(true);

/** The `GH_TOKEN` each branch lookup was made under, `""` for none. */
const branchLookups: Array<string> = [];

const RecordingPr = Layer.succeed(Pr, {
  status: (_cwd, bound) =>
    Effect.gen(function* () {
      if (bound === undefined) branchLookups.push((yield* GhCallEnv)["GH_TOKEN"] ?? "");
      return undefined;
    }),
  checks: () => Effect.succeed([]),
  prime: () => Effect.void,
  seenChecks: () => Effect.succeed(undefined),
  detail: () => Effect.succeed({ available: false }),
});

const layer = GitStatePublisherLive.pipe(
  Layer.provideMerge(RuntimeTestLayer),
  Layer.provideMerge(gitPlatformTest({ pr: RecordingPr })),
);

describe.skipIf(!hasGit)("a checkout's own GitHub reads behind a GitHub route", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
    branchLookups.length = 0;
  });
  const repo = () => {
    const dir = tempDir();
    dirs.push(dir);
    return makeRepo(dir);
  };

  it.live("are made for a thread on it, and not made for one no thread is on", () =>
    Effect.gen(function* () {
      const publisher = yield* GitStatePublisher;
      const runtimes = yield* ThreadRuntimes;
      const nobodys = repo();
      yield* publisher.refresh(nobodys, { remote: true });
      expect(branchLookups).toEqual([]);
      const root = repo();
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* publisher.refresh(root, { remote: true });
      expect(branchLookups.length).toBeGreaterThan(0);
      for (const token of branchLookups) expect(token).toBe(`gram-thread:${thread.id}`);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
