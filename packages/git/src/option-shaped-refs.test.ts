import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { PrStatus } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { git } from "./exec.ts";
import { GitStateRuntime, GitStateRuntimeLive } from "./git-state-runtime.ts";
import { fetchPrHead } from "./pr-checkout.ts";
import { Pr } from "./pr.ts";
import { ProcLive } from "./proc.ts";
import { localBaseRef } from "./refs.ts";
import { remoteGit } from "./remote-git.ts";
import { hasGit, makeRepo, removeDir, run, tempDir } from "./test-utils.ts";

/**
 * A synthetic repository whose own `.git` names its branch, `origin/HEAD`'s target and a remote
 * like a git option that runs a program, `mark`, which leaves a file behind. Nothing Gram does in
 * it may run `mark`.
 */
const hostileRepo = (root: string) => {
  const marker = nodePath.join(root, "ran");
  const program = nodePath.join(root, "mark");
  fs.writeFileSync(program, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  const name = `--upload-pack=${program}`;
  const origin = nodePath.join(root, "origin.git");
  run(root, "init", "-q", "--bare", "-b", "main", origin);
  const repo = makeRepo(root);
  run(repo, "remote", "add", "origin", origin);
  run(repo, "push", "-q", "origin", "main");
  run(repo, "fetch", "-q", "origin");
  run(origin, "update-ref", "refs/pull/12/head", "main");
  run(repo, "update-ref", `refs/heads/${name}`, "HEAD");
  run(repo, "update-ref", `refs/remotes/origin/${name}`, "HEAD");
  run(repo, "config", `remote.${name}.url`, "git@github.com:acme/web.git");
  return {
    repo,
    origin,
    name,
    ran: () => fs.existsSync(marker),
    onHostileBranch: () => run(repo, "symbolic-ref", "HEAD", `refs/heads/${name}`),
    hostileOriginHead: () =>
      run(repo, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${name}`),
    /** That git itself does run `mark` here, so a clean run below means Gram kept it out. */
    live: () => {
      spawnSync("git", ["fetch", "--quiet", "origin", name], {
        cwd: repo,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        stdio: "ignore",
      });
      const ran = fs.existsSync(marker);
      fs.rmSync(marker, { force: true });
      return ran;
    },
  };
};

const runtimeWith = (badge: PrStatus | undefined) =>
  GitStateRuntime.pipe(
    Effect.provide(
      GitStateRuntimeLive.pipe(
        Layer.provide(
          Layer.succeed(Pr, {
            status: () => Effect.succeed(badge),
            checks: () => Effect.succeed([]),
            prime: () => Effect.void,
            seenChecks: () => Effect.succeed(undefined),
            detail: () => Effect.succeed({ available: false }),
          }),
        ),
        Layer.provide(ProcLive),
      ),
    ),
  );

const badge = (baseRef: string): PrStatus => ({
  number: 12,
  state: "OPEN",
  url: "https://github.com/acme/web/pull/12",
  title: "t",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  baseRef,
});

describe.skipIf(!hasGit || process.platform === "win32")(
  "option-shaped names from a repository",
  () => {
    const dirs: Array<string> = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) removeDir(dir);
    });
    const setup = () => {
      const root = tempDir();
      dirs.push(root);
      const fixture = hostileRepo(root);
      expect(fixture.live()).toBe(true);
      return fixture;
    };

    it.effect("the background fetch runs nothing from the branch, origin/HEAD or a PR's base", () =>
      Effect.gen(function* () {
        const onBranch = setup();
        onBranch.onHostileBranch();
        const first = yield* runtimeWith(undefined);
        const state = yield* first.snapshot(onBranch.repo, { remote: true });
        expect(state.branch).toBeUndefined();
        expect(onBranch.ran()).toBe(false);

        const viaOriginHead = setup();
        viaOriginHead.hostileOriginHead();
        expect(yield* localBaseRef(viaOriginHead.repo).pipe(Effect.provide(ProcLive))).toBe(
          "origin/main",
        );
        const second = yield* runtimeWith(undefined);
        yield* second.snapshot(viaOriginHead.repo, { remote: true });
        expect(viaOriginHead.ran()).toBe(false);

        const viaPr = setup();
        const third = yield* runtimeWith(badge(viaPr.name));
        yield* third.snapshot(viaPr.repo, { remote: true });
        expect(viaPr.ran()).toBe(false);
      }),
    );

    it.effect("PR checkout passes over a remote named like an option", () =>
      Effect.gen(function* () {
        const fixture = setup();
        const checkedOut = yield* fetchPrHead(fixture.repo, {
          repo: "acme/web",
          number: 12,
          url: `${nodePath.join(nodePath.dirname(fixture.origin), "origin")}/pull/12`,
          title: "t",
          headRefName: "main",
          fork: true,
        }).pipe(Effect.provide(ProcLive), Effect.exit);
        expect(fixture.ran()).toBe(false);
        expect(checkedOut).toEqual(Exit.succeed("pr-12-main"));
      }),
    );

    it.effect("remoteGit and git refuse an option-shaped value where a ref or remote goes", () =>
      Effect.gen(function* () {
        const fixture = setup();
        for (const args of [
          ["fetch", "--quiet", "origin", fixture.name],
          ["fetch", "--quiet", "--end-of-options", "origin", fixture.name],
          ["fetch", "--quiet", "--end-of-options", fixture.name],
          ["ls-remote", "--", fixture.name],
        ]) {
          const refused = yield* Effect.flip(
            remoteGit(fixture.repo, args).pipe(Effect.provide(ProcLive)),
          );
          expect(refused._tag).toBe("ProcSpawnError");
        }
        const refused = yield* Effect.flip(
          git(fixture.repo, ["rev-parse", "--end-of-options", fixture.name]).pipe(
            Effect.provide(ProcLive),
          ),
        );
        expect(refused._tag).toBe("ProcSpawnError");
        expect(fixture.ran()).toBe(false);
      }),
    );
  },
);
