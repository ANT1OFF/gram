import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { git } from "./exec.ts";
import { ProcLive } from "./proc.ts";
import { guardFor, parseConfigList, withGuardArgs } from "./repo-config-guard.ts";
import { hasGit, removeDir, run, tempDir } from "./test-utils.ts";

const dirs: Array<string> = [];
afterEach(() => {
  while (dirs.length > 0) removeDir(dirs.pop()!);
});

/** A repo with one commit, and a marker path any planted command would create. */
const setup = () => {
  const root = tempDir();
  dirs.push(root);
  const repo = nodePath.join(root, "repo");
  fs.mkdirSync(repo);
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.email", "test@example.invalid");
  run(repo, "config", "user.name", "Test");
  fs.writeFileSync(nodePath.join(repo, ".gitattributes"), "*.txt filter=planted diff=planted\n");
  fs.writeFileSync(nodePath.join(repo, "a.txt"), "one\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-qm", "init");
  const marker = (name: string) => nodePath.join(root, `ran-${name}`);
  const plant = (key: string, name: string) =>
    run(repo, "config", key, `touch '${marker(name)}'; cat`);
  const ran = () => fs.readdirSync(root).filter((n) => n.startsWith("ran-"));
  return { repo, root, plant, ran, marker };
};

const provide = Effect.provide(ProcLive);

describe.skipIf(!hasGit)("Gram's own git and the repository's config", () => {
  it.live("runs nothing the repository's config names, on status, add, diff and log", () =>
    Effect.gen(function* () {
      const { repo, plant, ran } = setup();
      plant("core.fsmonitor", "fsmonitor");
      plant("filter.planted.clean", "clean");
      plant("filter.planted.process", "process");
      plant("diff.planted.textconv", "textconv");
      plant("diff.planted.command", "diff-command");
      plant("diff.external", "external");
      fs.writeFileSync(nodePath.join(repo, "a.txt"), "two\n");
      fs.writeFileSync(nodePath.join(repo, "b.txt"), "new\n");

      expect((yield* git(repo, ["status", "--porcelain"])).status).toBe(0);
      expect((yield* git(repo, ["diff"])).stdout).toContain("+two");
      expect((yield* git(repo, ["add", "-A"])).status).toBe(0);
      expect((yield* git(repo, ["diff", "--cached"])).stdout).toContain("+new");
      // The fixture commits with its own overrides: only Gram's calls are under test.
      run(
        repo,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "filter.planted.clean=",
        "-c",
        "filter.planted.process=",
        "commit",
        "-qm",
        "x",
      );
      expect((yield* git(repo, ["log", "-p", "-1"])).stdout).toContain("+two");
      expect((yield* git(repo, ["show", "HEAD"])).stdout).toContain("+new");

      expect(ran()).toEqual([]);
    }).pipe(provide),
  );

  it.live("sees config an agent writes after Gram's last call in the same folder", () =>
    Effect.gen(function* () {
      const { repo, plant, ran } = setup();
      expect((yield* git(repo, ["status", "--porcelain"])).status).toBe(0);
      plant("core.fsmonitor", "fsmonitor");
      expect((yield* git(repo, ["status", "--porcelain"])).status).toBe(0);
      expect(ran()).toEqual([]);
    }).pipe(provide),
  );

  it.live("sees a plain folder an agent turned into a repository", () =>
    Effect.gen(function* () {
      const root = tempDir();
      dirs.push(root);
      const marker = nodePath.join(root, "ran");
      expect((yield* git(root, ["status", "--porcelain"])).status).not.toBe(0);
      run(root, "init", "-q");
      run(root, "config", "core.fsmonitor", `touch '${marker}'`);
      expect((yield* git(root, ["status", "--porcelain"])).status).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    }).pipe(provide),
  );

  it.live("keeps the user's own value for a key the repository also sets", () =>
    Effect.gen(function* () {
      const { repo, root, plant, ran } = setup();
      const global = nodePath.join(root, "global.gitconfig");
      fs.writeFileSync(global, '[diff "planted"]\n\ttextconv = tr a-z A-Z <\n');
      plant("diff.planted.textconv", "textconv");
      fs.writeFileSync(nodePath.join(repo, "a.txt"), "two\n");
      const out = yield* git(repo, ["diff"], { env: { GIT_CONFIG_GLOBAL: global } });
      expect(out.stdout).toContain("+TWO");
      expect(ran()).toEqual([]);
    }).pipe(provide),
  );
});

describe("guardFor", () => {
  it.skipIf(!hasGit)("keeps git's built-in file monitor the repository turned on", () => {
    const { repo } = setup();
    run(repo, "config", "core.fsmonitor", "true");
    const guard = guardFor(parseConfigList(run(repo, "config", "--list", "--show-scope", "-z")));
    expect(guard.pairs.some(([key]) => key === "core.fsmonitor")).toBe(false);
  });

  it("rebuilds a credential helper list from the user's helpers alone", () => {
    const guard = guardFor([
      { scope: "global", key: "credential.helper", value: "osxkeychain" },
      { scope: "local", key: "credential.helper", value: "!planted" },
    ]);
    expect(guard.pairs.filter(([key]) => key === "credential.helper")).toEqual([
      ["credential.helper", ""],
      ["credential.helper", "osxkeychain"],
    ]);
  });

  it("puts --no-ext-diff after a diffing subcommand, past git's own options", () => {
    const guard = { pairs: [], noExtDiff: true, includes: false };
    expect(withGuardArgs(["-c", "core.quotepath=false", "diff", "HEAD"], guard)).toEqual([
      "-c",
      "core.quotepath=false",
      "diff",
      "--no-ext-diff",
      "HEAD",
    ]);
    expect(withGuardArgs(["stash", "show", "-p"], guard)).toEqual([
      "stash",
      "show",
      "--no-ext-diff",
      "-p",
    ]);
    expect(withGuardArgs(["status"], guard)).toEqual(["status"]);
  });
});
