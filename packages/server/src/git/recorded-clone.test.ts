// A new checkout's clone identity against its project's recorded origin: the same repository by
// another transport is the project's own, and only behind a GitHub route is another one refused.
import { describe, expect, it } from "@effect/vitest";
import type { Project } from "@gram/contracts";
import { Proc, ProcLive, ProcTimeout } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

/** A Proc whose `git remote get-url` fails as `failing` says; every other git answers nothing. */
const getUrlFails = (failing: "status" | "timeout") =>
  Layer.succeed(Proc, {
    run: (_bin, args) =>
      args.includes("get-url")
        ? failing === "timeout"
          ? Effect.fail(new ProcTimeout({ bin: "git", message: "git timed out" }))
          : Effect.succeed({
              status: 128,
              stdout: "",
              stderr: "fatal: bad config",
              truncated: false,
            })
        : Effect.succeed({ status: 1, stdout: "", stderr: "", truncated: false }),
  });

describe("where a folder's git goes, when git can't say", () => {
  it.effect.each(["status", "timeout"] as const)(
    "is refused behind a GitHub route when get-url fails (%s)",
    (failing) =>
      Effect.gen(function* () {
        relay.on = true;
        const out = yield* effectiveOriginsChecked(project, "/work/web").pipe(
          Effect.provide(getUrlFails(failing)),
          Effect.result,
        );
        expect(out._tag).toBe("Failure");
      }),
  );

  it.effect("is only logged, and goes ahead, without a GitHub route", () =>
    Effect.gen(function* () {
      relay.on = false;
      const out = yield* effectiveOriginsChecked(project, "/work/web").pipe(
        Effect.provide(getUrlFails("timeout")),
        Effect.result,
      );
      expect(out._tag).toBe("Success");
    }),
  );
});

describe.skipIf(!hasGit)("where a project folder's large files go", () => {
  it.effect("is refused behind a GitHub route when LFS is sent to another repository", () =>
    Effect.gen(function* () {
      relay.on = true;
      const config = yield* folder([
        "remote.origin.lfsurl",
        "https://github.com/someone/private.git/info/lfs",
      ]);
      expect((yield* checked(config.repo))._tag).toBe("Failure");
      const committed = yield* folder();
      run(
        committed.repo,
        "config",
        "-f",
        ".lfsconfig",
        "lfs.url",
        "https://github.com/someone/private.git/info/lfs",
      );
      expect((yield* checked(committed.repo))._tag).toBe("Failure");
      const same = yield* folder();
      run(
        same.repo,
        "config",
        "-f",
        ".lfsconfig",
        "lfs.url",
        "https://github.com/acme/web.git/info/lfs",
      );
      expect((yield* checked(same.repo))._tag).toBe("Success");
    }).pipe(Effect.scoped),
  );

  it.effect("is refused behind a GitHub route when an insteadOf sends origin to a local path", () =>
    Effect.gen(function* () {
      relay.on = true;
      const local = yield* folder(["url./tmp/elsewhere/.insteadOf", "https://github.com/acme/"]);
      expect((yield* checked(local.repo))._tag).toBe("Failure");
    }).pipe(Effect.scoped),
  );
});
