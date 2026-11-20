import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { git, STRICT_STATUS_ARGS } from "./exec.ts";
import { Proc, ProcLive } from "./proc.ts";
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

/** A repository with one submodule, as `git submodule add` lays it out. */
const withSubmodules = () => {
  const { repo, root, ran, marker } = setup();
  const lib = nodePath.join(root, "lib");
  fs.mkdirSync(lib);
  run(lib, "init", "-q", "-b", "main");
  fs.writeFileSync(nodePath.join(lib, ".gitattributes"), "*.txt filter=planted\n");
  fs.writeFileSync(nodePath.join(lib, "l.txt"), "lib\n");
  run(lib, "add", "-A");
  run(lib, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-qm", "lib");
  run(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "sub");
  run(repo, "commit", "-qm", "sub");
  const modules = nodePath.join(repo, ".git", "modules", "sub");
  const plantIn = (gitDir: string, key: string, name: string) =>
    run(
      repo,
      "config",
      "--file",
      nodePath.join(gitDir, "config"),
      key,
      `touch '${marker(name)}'; cat`,
    );
  return { repo, root, ran, modules, plantIn };
};

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

  it.live("sees the repository's config whatever GIT_CONFIG says", () =>
    Effect.gen(function* () {
      const { repo, plant, ran } = setup();
      plant("core.fsmonitor", "fsmonitor");
      fs.writeFileSync(nodePath.join(repo, "a.txt"), "two\n");
      const out = yield* git(repo, ["status", "--porcelain"], {
        env: { GIT_CONFIG: "/dev/null" },
      });
      expect(out.status).toBe(0);
      expect(ran()).toEqual([]);
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

describe.skipIf(!hasGit)("Gram's own git and a submodule's config", () => {
  it.live("runs nothing a submodule's own config names, on status and diff", () =>
    Effect.gen(function* () {
      const { repo, ran, modules, plantIn } = withSubmodules();
      plantIn(modules, "core.fsmonitor", "fsmonitor");
      plantIn(modules, "filter.planted.clean", "clean");
      fs.writeFileSync(nodePath.join(repo, "sub", "l.txt"), "lix\n");

      expect((yield* git(repo, ["status", "--porcelain"])).status).toBe(0);
      yield* git(repo, ["diff", "--quiet", "HEAD"]);
      // The check before a checkout is removed still sees the submodule's uncommitted change.
      expect((yield* git(repo, STRICT_STATUS_ARGS)).stdout).toContain("sub");

      expect(ran()).toEqual([]);
    }).pipe(provide),
  );

  it.live("follows a submodule config's includes", () =>
    Effect.gen(function* () {
      const { repo, ran, modules, plantIn } = withSubmodules();
      // The planted key sits in a file the submodule's config only includes.
      const elsewhere = nodePath.join(modules, "elsewhere");
      fs.mkdirSync(elsewhere);
      plantIn(elsewhere, "filter.planted.clean", "clean");
      const config = nodePath.join(modules, "config");
      run(repo, "config", "--file", config, "include.path", nodePath.join(elsewhere, "config"));
      // Same size, so git has to read the file, through its clean filter, to see the change.
      fs.writeFileSync(nodePath.join(repo, "sub", "l.txt"), "lix\n");
      expect((yield* git(repo, STRICT_STATUS_ARGS)).stdout).toContain("sub");
      expect(ran()).toEqual([]);
    }).pipe(provide),
  );

  it.live("judges a submodule config's conditional includes by the submodule", () =>
    Effect.gen(function* () {
      const { repo, ran, modules, plantIn } = withSubmodules();
      // Included only while the submodule, not the repository, is on this branch.
      run(nodePath.join(repo, "sub"), "checkout", "-qb", "elsewhere");
      const elsewhere = nodePath.join(modules, "elsewhere");
      fs.mkdirSync(elsewhere);
      plantIn(elsewhere, "filter.planted.clean", "clean");
      run(
        repo,
        "config",
        "--file",
        nodePath.join(modules, "config"),
        "includeIf.onbranch:elsewhere.path",
        nodePath.join(elsewhere, "config"),
      );
      // Same size, so git has to read the file, through its clean filter, to see the change.
      fs.writeFileSync(nodePath.join(repo, "sub", "l.txt"), "lix\n");
      expect((yield* git(repo, STRICT_STATUS_ARGS)).stdout).toContain("sub");
      expect(ran()).toEqual([]);
    }).pipe(provide),
  );

  it.live("runs no hook the repository has, on merge, checkout and commit", () =>
    Effect.gen(function* () {
      const { repo, ran, marker } = setup();
      const hook = (dir: string, name: string) => {
        fs.mkdirSync(dir, { recursive: true });
        const path = nodePath.join(dir, name);
        fs.writeFileSync(
          path,
          `#!/bin/sh\ntouch '${marker(`${nodePath.basename(dir)}-${name}`)}'\n`,
        );
        fs.chmodSync(path, 0o755);
      };
      const names = [
        "post-merge",
        "post-checkout",
        "pre-commit",
        "post-commit",
        "reference-transaction",
      ];
      // Both where git looks by default and where a repository's own `core.hooksPath` sends it.
      for (const name of names) hook(nodePath.join(repo, ".git", "hooks"), name);
      const own = nodePath.join(repo, "own-hooks");
      for (const name of names) hook(own, name);
      run(repo, "config", "core.hooksPath", own);
      run(repo, "-c", "core.hooksPath=/dev/null", "branch", "ahead");
      expect((yield* git(repo, ["checkout", "-q", "ahead"])).status).toBe(0);
      fs.writeFileSync(nodePath.join(repo, "a.txt"), "two\n");
      const commit = yield* git(repo, [
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "user.name=T",
        "commit",
        "-qam",
        "two",
      ]);
      expect(commit.status).toBe(0);
      expect((yield* git(repo, ["checkout", "-q", "main"])).status).toBe(0);
      expect((yield* git(repo, ["merge", "-q", "--ff-only", "ahead"])).status).toBe(0);
      expect(ran()).toEqual([]);
    }).pipe(provide),
  );

  it.live("runs nothing a nested repository's config names, wherever its git folder is", () =>
    Effect.gen(function* () {
      const { repo, ran, marker } = setup();
      // A repository inside the worktree, added as a gitlink, with its own `.git` folder: not one
      // `git submodule` made, so nothing under `.git/modules`.
      const inner = nodePath.join(repo, "inner");
      fs.mkdirSync(inner);
      run(inner, "init", "-q", "-b", "main");
      fs.writeFileSync(nodePath.join(inner, ".gitattributes"), "*.txt filter=nested\n");
      fs.writeFileSync(nodePath.join(inner, "n.txt"), "one\n");
      run(inner, "add", "-A");
      run(inner, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-qm", "n");
      run(repo, "add", "inner");
      run(repo, "commit", "-qm", "gitlink");
      run(inner, "config", "filter.nested.clean", `touch '${marker("nested-clean")}'; cat`);
      run(inner, "config", "core.fsmonitor", `touch '${marker("nested-fsmonitor")}'; false`);
      // `.gitmodules` asks for the strictest status; Gram's strict callers ask for it themselves.
      fs.writeFileSync(
        nodePath.join(repo, ".gitmodules"),
        '[submodule "inner"]\n\tpath = inner\n\tignore = none\n',
      );
      // Same size, so git has to read the file, through its clean filter, to see the change.
      fs.writeFileSync(nodePath.join(inner, "n.txt"), "two\n");

      expect((yield* git(repo, STRICT_STATUS_ARGS)).stdout).toContain("inner");
      expect((yield* git(repo, ["status", "--porcelain"])).status).toBe(0);
      yield* git(repo, ["diff", "HEAD"]);
      expect(ran()).toEqual([]);
    }).pipe(provide),
  );

  it.live(
    "guards a nested repository whose .git is a link, or that is checked out after a call",
    () =>
      Effect.gen(function* () {
        const { repo, root, ran, marker } = setup();
        const inner = nodePath.join(repo, "inner");
        fs.mkdirSync(inner);
        run(inner, "init", "-q", "-b", "main");
        fs.writeFileSync(nodePath.join(inner, ".gitattributes"), "*.txt filter=nested\n");
        fs.writeFileSync(nodePath.join(inner, "n.txt"), "one\n");
        run(inner, "add", "-A");
        run(inner, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-qm", "n");
        run(repo, "add", "inner");
        run(repo, "commit", "-qm", "gitlink");
        // Nothing checked out at the gitlink when Gram first looks, so the guard it keeps has no
        // nested config in it.
        const away = nodePath.join(root, "inner-git");
        fs.renameSync(nodePath.join(inner, ".git"), away);
        expect((yield* git(repo, STRICT_STATUS_ARGS)).status).toBe(0);
        // Then the agent puts it back as a link git follows, with a filter in its config.
        if (process.platform !== "win32") fs.symlinkSync(away, nodePath.join(inner, ".git"));
        else fs.renameSync(away, nodePath.join(inner, ".git"));
        run(inner, "config", "filter.nested.clean", `touch '${marker("nested-clean")}'; cat`);
        fs.writeFileSync(nodePath.join(inner, "n.txt"), "two\n");
        expect((yield* git(repo, STRICT_STATUS_ARGS)).stdout).toContain("inner");
        expect(ran()).toEqual([]);
      }).pipe(provide),
  );

  it.live("sees a nested repository's shared config change after Gram's last call", () =>
    Effect.gen(function* () {
      const { repo, root, ran, marker } = setup();
      const inner = nodePath.join(repo, "inner");
      fs.mkdirSync(inner);
      run(inner, "init", "-q", "-b", "main");
      fs.writeFileSync(nodePath.join(inner, ".gitattributes"), "*.txt filter=nested\n");
      fs.writeFileSync(nodePath.join(inner, "n.txt"), "one\n");
      run(inner, "add", "-A");
      run(inner, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-qm", "n");
      run(repo, "add", "inner");
      run(repo, "commit", "-qm", "gitlink");
      // The nested repository's git folder is a worktree's: its config is in the common dir its
      // `commondir` names.
      const common = nodePath.join(root, "common");
      fs.renameSync(nodePath.join(inner, ".git"), common);
      const own = nodePath.join(root, "own");
      fs.mkdirSync(own);
      fs.writeFileSync(nodePath.join(own, "commondir"), `${common}\n`);
      for (const file of ["HEAD", "index"])
        fs.copyFileSync(nodePath.join(common, file), nodePath.join(own, file));
      fs.writeFileSync(nodePath.join(inner, ".git"), `gitdir: ${own}\n`);
      expect((yield* git(repo, STRICT_STATUS_ARGS)).status).toBe(0);
      run(inner, "config", "filter.nested.clean", `touch '${marker("common-clean")}'; cat`);
      fs.writeFileSync(nodePath.join(inner, "n.txt"), "two\n");
      expect((yield* git(repo, STRICT_STATUS_ARGS)).status).toBe(0);
      expect(ran()).toEqual([]);
    }).pipe(provide),
  );

  it.live.skipIf(process.platform === "win32")("gives the git that gh starts the same guard", () =>
    Effect.gen(function* () {
      const { repo, root, plant, ran } = setup();
      plant("core.fsmonitor", "fsmonitor");
      fs.writeFileSync(nodePath.join(repo, "a.txt"), "two\n");
      // A stand-in `gh` that does what the real one does in a checkout: runs git there.
      const bin = nodePath.join(root, "bin");
      fs.mkdirSync(bin);
      const gh = nodePath.join(bin, "gh");
      fs.writeFileSync(gh, "#!/bin/sh\nexec git status --porcelain\n");
      fs.chmodSync(gh, 0o755);
      const proc = yield* Proc;
      const out = yield* proc.run(gh, ["pr", "create"], { cwd: repo });
      expect(out.status).toBe(0);
      expect(out.stdout).toContain("a.txt");
      expect(ran()).toEqual([]);
    }).pipe(provide),
  );

  it.live("sees a submodule's git folder pointed at a shared config after Gram's last call", () =>
    Effect.gen(function* () {
      const { repo, root, ran, modules } = withSubmodules();
      fs.rmSync(nodePath.join(repo, ".gitattributes"));
      run(repo, "commit", "-qam", "no attributes");
      const common = nodePath.join(root, "common");
      fs.cpSync(modules, common, { recursive: true });
      fs.appendFileSync(
        nodePath.join(common, "config"),
        `[filter "planted"]\n\tclean = touch '${nodePath.join(root, "ran-shared")}'; cat\n`,
      );
      expect((yield* git(repo, STRICT_STATUS_ARGS)).status).toBe(0);
      fs.writeFileSync(nodePath.join(modules, "commondir"), "../../../../common\n");
      fs.writeFileSync(nodePath.join(repo, "sub", "l.txt"), "two\n");
      expect((yield* git(repo, STRICT_STATUS_ARGS)).status).toBe(0);
      expect(ran()).toEqual([]);
    }).pipe(provide),
  );

  it.live("sees a submodule config an agent writes after Gram's last call", () =>
    Effect.gen(function* () {
      const { repo, ran, modules, plantIn } = withSubmodules();
      expect((yield* git(repo, STRICT_STATUS_ARGS)).status).toBe(0);
      plantIn(modules, "core.fsmonitor", "fsmonitor");
      fs.writeFileSync(nodePath.join(repo, "sub", "l.txt"), "changed\n");
      expect((yield* git(repo, STRICT_STATUS_ARGS)).status).toBe(0);
      expect(ran()).toEqual([]);
    }).pipe(provide),
  );
});

describe("guardFor", () => {
  it.skipIf(!hasGit)("keeps git's built-in file monitor the repository turned on", () => {
    const { repo } = setup();
    run(repo, "config", "core.fsmonitor", "true");
    const guard = guardFor(parseConfigList(run(repo, "config", "--list", "--show-scope", "-z")));
    expect(guard.pairs.filter(([key]) => key === "core.fsmonitor").at(-1)).toEqual([
      "core.fsmonitor",
      "true",
    ]);
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
