import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Proc, ProcLive, ProcSpawnError, type ProcShape } from "@gram/git";
import * as Effect from "effect/Effect";
import { makeRepo, removeDir, tempDir } from "../git/test-repo.ts";
import { cloneFolderOf, reposOn } from "./repos.ts";

const URL = "https://git.example.test/acme/widgets.git";

/** A remote at `URL` that is really a bare repository here, reached through `insteadOf`. */
const localRemote = (dir: string) => {
  const work = makeRepo(join(dir, "work"));
  const bare = join(dir, "widgets.git");
  execFileSync("git", ["clone", "--quiet", "--bare", work, bare]);
  return {
    work,
    env: {
      GIT_ALLOW_PROTOCOL: "https:ssh:file",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`,
      GIT_CONFIG_VALUE_0: URL,
    },
  };
};

const tip = (cwd: string, ref: string) =>
  execFileSync("git", ["-C", cwd, "rev-parse", ref], { encoding: "utf8" }).trim();

describe("cloneFolderOf", () => {
  it("files a remote under its host, owner and name", () => {
    expect(cloneFolderOf("https://github.com/acme/widgets.git")).toEqual({
      folder: join("github.com", "acme", "widgets"),
    });
    expect(cloneFolderOf("git@github.com:acme/widgets.git")).toEqual({
      folder: join("github.com", "acme", "widgets"),
    });
    expect(cloneFolderOf("ssh://git@GitHub.com:22/acme/widgets")).toEqual({
      folder: join("github.com", "acme", "widgets"),
    });
    // Always three levels, so no clone is inside another's folder.
    expect(cloneFolderOf("https://gitlab.com/group/sub/widgets.git")).toEqual({
      folder: join("gitlab.com", "group", "sub+widgets"),
    });
  });

  it("refuses passwords for every URL transport and constrains SSH usernames", () => {
    for (const url of [
      "ssh://git:invented-audit-password@git.example.test/acme/widgets",
      "ssh://git:%69nvented@git.example.test/acme/widgets",
      "ssh://-option@git.example.test/acme/widgets",
      "ssh://user%40other@git.example.test/acme/widgets",
      "ssh://user%3Apassword@git.example.test/acme/widgets",
      "-option@git.example.test:acme/widgets",
    ])
      expect(cloneFolderOf(url), url).toHaveProperty("error");
  });

  it("refuses what it shouldn't clone or can't file safely", () => {
    for (const url of [
      "file:///etc",
      "/srv/repos/widgets.git",
      "ext::sh -c touch% /tmp/pwned",
      "-uhelp",
      "https://user:token@github.com/acme/widgets.git",
      "https://github.com/acme/../widgets.git",
      "https://github.com/widgets",
      "git://github.com/acme/widgets.git",
      "https://github.com/acme/a%zz",
      "https://github.com/acme/widgets/.git/hooks",
      "https://github.com/acme/.hidden",
    ])
      expect(cloneFolderOf(url), url).toHaveProperty("error");
  });
});

describe("reposOn", () => {
  it.effect("clones a repository once, then fetches it and keeps the same folder", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const { work, env } = localRemote(dir);
      const root = join(dir, "repos");
      const repos = reposOn(yield* Proc, root, env);
      const first = yield* repos.ensure(URL);
      expect(first.path).toBe(join(root, "git.example.test", "acme", "widgets"));
      expect(existsSync(join(first.path, "tracked.txt"))).toBe(true);
      // Only the clone is left in its owner's folder, no partial one beside it.
      expect(readdirSync(join(root, "git.example.test", "acme"))).toEqual(["widgets"]);

      execFileSync("git", ["-C", work, "commit", "--quiet", "--allow-empty", "-m", "later"]);
      execFileSync("git", ["-C", work, "push", "--quiet", join(dir, "widgets.git"), "HEAD"]);
      const again = yield* repos.ensure(URL);
      expect(again.path).toBe(first.path);
      expect(tip(again.path, "origin/HEAD")).toBe(tip(work, "HEAD"));
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.effect("refuses a folder already there that isn't a clone of that remote", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const root = join(dir, "repos");
      makeRepo(join(root, "git.example.test", "acme", "widgets"));
      const error = yield* reposOn(yield* Proc, root)
        .ensure(URL)
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "WorktreeError", reason: "conflict" });
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  it.effect("never clones through a link out of its folder", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const { env } = localRemote(dir);
      const root = join(dir, "repos");
      const elsewhere = join(dir, "elsewhere");
      mkdirSync(elsewhere);
      mkdirSync(join(root, "git.example.test"), { recursive: true });
      symlinkSync(elsewhere, join(root, "git.example.test", "acme"));
      const error = yield* reposOn(yield* Proc, root, env)
        .ensure(URL)
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "WorktreeError", reason: "conflict" });
      expect(readdirSync(elsewhere)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );

  for (const [kept, requested] of [
    [
      "ssh://git@git.example.test:2222/acme/widgets",
      "ssh://git@git.example.test:3333/acme/widgets",
    ],
    ["ssh://alice@git.example.test/acme/widgets", "ssh://bob@git.example.test/acme/widgets"],
    ["https://git.example.test/acme/widgets", "ssh://git@git.example.test/acme/widgets"],
    ["git@git.example.test:acme/widgets", "ssh://git@git.example.test/acme/widgets"],
    ["https://git.example.test:8443/acme/widgets", "https://git.example.test/acme/widgets"],
    ["https://git.example.test/acme/widgets.git", "https://git.example.test/acme/widgets"],
  ]) {
    it.effect(`refuses a folder collision between ${kept} and ${requested} without fetching`, () =>
      Effect.gen(function* () {
        const dir = tempDir();
        yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
        const folder = cloneFolderOf(requested!);
        if ("error" in folder) throw new Error(folder.error);
        mkdirSync(join(dir, folder.folder), { recursive: true });
        const calls: string[][] = [];
        const proc: ProcShape = {
          run: (_bin, args) => {
            calls.push([...args]);
            return Effect.succeed({ status: 0, stdout: kept!, stderr: "", truncated: false });
          },
        };
        const result = yield* reposOn(proc, dir).ensure(requested!).pipe(Effect.result);
        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "conflict" } });
        expect(calls).toEqual([["remote", "get-url", "origin"]]);
      }).pipe(Effect.scoped),
    );
  }

  it.effect("never passes an SSH password to clone", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const calls: string[][] = [];
      const proc: ProcShape = {
        run: (_bin, args) => {
          calls.push([...args]);
          return Effect.succeed({ status: 1, stdout: "", stderr: "refused", truncated: false });
        },
      };
      const error = yield* reposOn(proc, dir)
        .ensure("ssh://git:invented-audit-password@git.example.test/acme/widgets")
        .pipe(Effect.flip);
      expect(error.reason).toBe("invalidRequest");
      expect(calls).toEqual([]);
      expect(error.message).not.toContain("invented-audit-password");
    }).pipe(Effect.scoped),
  );

  for (const thrown of [false, true]) {
    it.effect(
      `redacts credentials in ${thrown ? "spawn failures" : "command stderr"} independently of admission`,
      () =>
        Effect.gen(function* () {
          const dir = tempDir();
          yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
          const message =
            "redirect refused ssh://user:invented-audit-password@git.example.test/acme/widgets";
          const proc: ProcShape = {
            run: () =>
              thrown
                ? Effect.fail(new ProcSpawnError({ bin: "git", message }))
                : Effect.succeed({ status: 1, stdout: "", stderr: message, truncated: false }),
          };
          const error = yield* reposOn(proc, dir).ensure(URL).pipe(Effect.flip);
          expect(error.message).not.toContain("invented-audit-password");
          expect(error.message).toContain("[redacted]");
        }).pipe(Effect.scoped),
    );
  }

  it.effect("leaves nothing behind when a clone fails", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const root = join(dir, "repos");
      // The rewrite points at a file remote that isn't allowed, so git refuses it.
      const { env } = localRemote(dir);
      const error = yield* reposOn(yield* Proc, root, { ...env, GIT_ALLOW_PROTOCOL: "https" })
        .ensure(URL)
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "WorktreeError", reason: "failed" });
      expect(readdirSync(join(root, "git.example.test", "acme"))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ProcLive)),
  );
});
