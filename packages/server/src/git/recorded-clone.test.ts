// A new checkout's clone identity against its project's recorded origin: the same repository by
// another transport is the project's own, and only behind a GitHub route is another one refused.
import { describe, expect, it } from "@effect/vitest";
import type { Project } from "@gram/contracts";
import { ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { cloneIdentityOf } from "../host/repos.ts";
import { effectiveOriginsChecked, recordedCloneIdentity } from "./recorded-clone.ts";
import { hasGit, makeRepo, removeDirStrict, run, tempDir } from "./test-repo.ts";

const relay = vi.hoisted(() => ({ on: true }));
vi.mock("../embedding/github-relay.ts", async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  githubRelayed: () => relay.on,
}));

const project = {
  id: "p-1",
  name: "web",
  root: "/work/web",
  originIdentity: cloneIdentityOf("https://github.com/acme/web.git"),
} as unknown as Project;

const check = (url: string) =>
  recordedCloneIdentity([project], "/work/web", cloneIdentityOf(url)).pipe(Effect.result);

describe("a new checkout's clone identity", () => {
  it.effect("is the live one when it names the recorded repository by ssh", () =>
    Effect.gen(function* () {
      relay.on = true;
      const ssh = cloneIdentityOf("git@github.com:acme/web.git");
      expect(yield* check("git@github.com:acme/web.git")).toMatchObject({ success: ssh });
    }),
  );

  it.effect("is refused behind a GitHub route when it names another repository", () =>
    Effect.gen(function* () {
      relay.on = true;
      expect((yield* check("https://github.com/someone/private.git"))._tag).toBe("Failure");
    }),
  );

  it.effect("is kept, and the mismatch only logged, without a GitHub route", () =>
    Effect.gen(function* () {
      relay.on = false;
      expect((yield* check("https://github.com/someone/private.git"))._tag).toBe("Success");
    }),
  );
});

/** A repository whose stored origin is acme/web, with `config` added to its own config. */
const folder = (...config: Array<[string, string]>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const tmp = tempDir();
      const repo = makeRepo(tmp);
      run(repo, "remote", "add", "origin", "https://github.com/acme/web.git");
      for (const [key, value] of config) run(repo, "config", "--add", key, value);
      return { tmp, repo };
    }),
    ({ tmp }) => Effect.sync(() => removeDirStrict(tmp)),
  );
const checked = (repo: string) =>
  effectiveOriginsChecked({ ...project, root: repo } as Project, repo).pipe(
    Effect.provide(ProcLive),
    Effect.result,
  );

describe.skipIf(!hasGit)("where a project folder's git fetches and pushes origin", () => {
  it.effect("is refused behind a GitHub route when a pushurl or insteadOf sends it elsewhere", () =>
    Effect.gen(function* () {
      relay.on = true;
      const pushurl = yield* folder([
        "remote.origin.pushurl",
        "https://github.com/someone/private.git",
      ]);
      expect((yield* checked(pushurl.repo))._tag).toBe("Failure");
      const instead = yield* folder([
        "url.https://github.com/someone/.insteadOf",
        "https://github.com/acme/",
      ]);
      expect((yield* checked(instead.repo))._tag).toBe("Failure");
      const pushInstead = yield* folder([
        "url.https://github.com/someone/.pushInsteadOf",
        "https://github.com/acme/",
      ]);
      expect((yield* checked(pushInstead.repo))._tag).toBe("Failure");
    }).pipe(Effect.scoped),
  );

  it.effect("passes a pushurl to the same repository by ssh", () =>
    Effect.gen(function* () {
      relay.on = true;
      const ssh = yield* folder(["remote.origin.pushurl", "git@github.com:acme/web.git"]);
      expect((yield* checked(ssh.repo))._tag).toBe("Success");
    }).pipe(Effect.scoped),
  );
});
