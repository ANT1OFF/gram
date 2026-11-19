import { describe, expect, it } from "@effect/vitest";
import { ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import { makeRepo, run, write } from "../git/test-repo.ts";
import { localChecks } from "./sent-work-routes.ts";

/** A repository with a bare origin it pushed `main` to. */
const pushed = () => {
  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "send-check-"));
  const repo = makeRepo(tmp);
  const origin = nodePath.join(tmp, "origin.git");
  run(tmp, "init", "-q", "--bare", "-b", "main", origin);
  run(repo, "remote", "add", "origin", origin);
  run(repo, "push", "-q", "-u", "origin", "main");
  run(repo, "remote", "set-head", "origin", "main");
  return repo;
};

describe("what New task checks before it sends a task", () => {
  it.effect("names the base there, the commits it lacks and what stays uncommitted", () =>
    Effect.gen(function* () {
      const repo = pushed();
      const sha = run(repo, "rev-parse", "--short", "HEAD").trim();
      expect(yield* localChecks(repo)).toEqual({
        current: "main",
        base: { branch: "main", sha },
        ahead: 0,
        uncommitted: { count: 0 },
      });

      // On a branch of its own, two commits there lacks, and a change not committed.
      run(repo, "checkout", "-q", "-b", "feat/keys");
      for (const name of ["a", "b"]) {
        write(nodePath.join(repo, `${name}.txt`), name);
        run(repo, "add", "-A");
        run(repo, "commit", "-qm", name);
      }
      write(nodePath.join(repo, "tracked.txt"), "changed\n");
      expect(yield* localChecks(repo)).toEqual({
        current: "feat/keys",
        base: { branch: "main", sha },
        ahead: 2,
        uncommitted: { count: 1, first: "tracked.txt" },
      });
    }).pipe(Effect.provide(ProcLive)),
  );

  it.effect("has no base where nothing was pushed", () =>
    Effect.gen(function* () {
      const repo = makeRepo(fs.mkdtempSync(nodePath.join(os.tmpdir(), "send-check-")));
      const checks = yield* localChecks(repo);
      expect(checks.base).toBeUndefined();
      expect(checks.ahead).toBe(0);
    }).pipe(Effect.provide(ProcLive)),
  );
});
