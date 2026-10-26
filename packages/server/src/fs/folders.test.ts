import { describe, expect, it } from "@effect/vitest";
import { GitError, InvalidState, NotFound, notARepositoryMessage } from "@gram/contracts";
import { Proc, ProcTimeout, type ProcOutput, type ProcShape } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, ProjectId } from "@gram/contracts";
import {
  cloneFailure,
  cloneFailureMessage,
  cloneRepo,
  lastPage,
  makeCloneSuggestions,
} from "./clone.ts";
import {
  browseFolders,
  expandHome,
  folderError,
  registerRepo,
  repoFolder,
  repoIdentity,
  reposIn,
  repositoryCandidates,
  resolveFolder,
} from "./folders.ts";

/** A temp tree: repo-a (git), repo-b, notes (folder), readme.txt (file), .hidden (folder). */
const tempTree = Effect.gen(function* () {
  const root = mkdtempSync(join(tmpdir(), "gram-folders-"));
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { recursive: true })));
  mkdirSync(join(root, "repo-a", ".git"), { recursive: true });
  mkdirSync(join(root, "repo-b"));
  mkdirSync(join(root, "Notes"));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "readme.txt"), "hi");
  return root;
});

/** The two `ThreadStore` calls `registerRepo` makes, over an array. */
const fakeStore = () => {
  const projects: Array<Project> = [];
  const store = {
    listProjects: Effect.sync(() => projects),
    registerProject: (input: { root: string; name: string; repoRoot?: string }) =>
      Effect.sync(() => {
        const project: Project = {
          id: `p-${projects.length}` as ProjectId,
          root: input.root,
          name: input.name,
          ...(input.repoRoot === undefined ? {} : { repoRoot: input.repoRoot }),
          bookmarked: false,
        };
        projects.push(project);
        return { project, created: true };
      }),
  };
  return { projects, store };
};

describe("expandHome", () => {
  it("expands a leading ~ only", () => {
    expect(expandHome("~", "/home/me")).toBe("/home/me");
    expect(expandHome("~/code", "/home/me")).toBe(join("/home/me", "code"));
    expect(expandHome("/tmp/~x", "/home/me")).toBe("/tmp/~x");
  });
});

describe("folderError", () => {
  it("maps errno codes to friendly contract errors", () => {
    expect(folderError({ code: "ENOENT" }, "/nope")).toEqual(
      new NotFound({ entity: "project", id: "/nope", message: `Folder not found: ${"/nope"}` }),
    );
    expect(folderError({ code: "ENOTDIR" }, "/f")).toMatchObject({ message: "Not a folder: /f" });
    expect(folderError({ code: "EACCES" }, "/secret", "darwin")).toMatchObject({
      message: expect.stringContaining("Files & Folders"),
    });
    expect(folderError({ code: "EPERM" }, "/secret", "linux")).toMatchObject({
      message: "Permission denied: /secret",
    });
    // Unknown failures don't leak platform error text.
    const other = folderError(new Error("FileSystem.access weird"), "/x");
    expect(other).toBeInstanceOf(InvalidState);
    expect(other).toMatchObject({ message: "Can't open /x" });
  });
});

describe("resolveFolder", () => {
  it.effect("accepts folders, expands ~, and rejects missing paths and files", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      expect(yield* resolveFolder(join(root, "repo-a"))).toBe(join(root, "repo-a"));
      expect(yield* resolveFolder("~/repo-b", root)).toBe(join(root, "repo-b"));

      const missing = yield* resolveFolder(join(root, "nope")).pipe(Effect.flip);
      expect(missing).toEqual(
        new NotFound({
          entity: "project",
          id: join(root, "nope"),
          message: `Folder not found: ${join(root, "nope")}`,
        }),
      );

      const file = yield* resolveFolder(join(root, "readme.txt")).pipe(Effect.flip);
      expect(file).toBeInstanceOf(InvalidState);
      expect(file).toMatchObject({ message: `Not a folder: ${join(root, "readme.txt")}` });
    }),
  );
});

describe("repoFolder, registerRepo and repoIdentity", () => {
  it.effect("takes a repository's own top folder and nothing else", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      expect(yield* repoFolder("~/repo-a", root)).toBe(join(root, "repo-a"));
      expect(yield* repoFolder(join(root, "repo-b")).pipe(Effect.flip)).toMatchObject({
        message: notARepositoryMessage(join(root, "repo-b")),
      });
      writeFileSync(join(root, "repo-b", ".git"), "gitdir: ../repo-a/.git/worktrees/b\n");
      expect(yield* repoFolder(join(root, "repo-b")).pipe(Effect.flip)).toMatchObject({
        message: expect.stringContaining("is a linked worktree or a submodule"),
      });
      expect(yield* repoFolder(join(root, "nope")).pipe(Effect.flip)).toBeInstanceOf(NotFound);
    }),
  );

  it.effect("tells a repository from another moved into its folder", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const repo = join(root, "repo-a");
      const before = yield* repoIdentity(repo);
      expect(before).toBeDefined();
      expect(yield* repoIdentity(repo)).toBe(before);
      // A new directory made while the old one still exists can't reuse its inode.
      const other = join(root, "repo-c");
      mkdirSync(join(other, ".git"), { recursive: true });
      rmSync(repo, { recursive: true });
      renameSync(other, repo);
      expect(yield* repoIdentity(repo)).not.toBe(before);
      expect(yield* repoIdentity(join(root, "repo-b"))).toBeUndefined();
    }),
  );

  it.effect("registers a repository once, and returns the project it already is", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const { projects, store } = fakeStore();
      const repo = join(root, "repo-a");
      const added = yield* registerRepo(store, `${repo}/`);
      expect(added).toMatchObject({
        created: true,
        project: { root: repo, name: "repo-a", repoRoot: repo },
      });
      expect(yield* registerRepo(store, repo)).toEqual({ project: added.project, created: false });
      expect(projects).toHaveLength(1);
      yield* registerRepo(store, join(root, "Notes")).pipe(Effect.flip);
      expect(projects).toHaveLength(1);
    }),
  );

  it.effect("takes a project spelled in another case for the repository only on Windows", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const { projects, store } = fakeStore();
      yield* store.registerProject({ root: join(root, "REPO-A"), name: "REPO-A" });
      const { created } = yield* registerRepo(store, join(root, "repo-a"));
      // As `repositoryCandidates` offers it: another repository wherever case counts.
      expect(created).toBe(process.platform !== "win32");
      expect(projects).toHaveLength(process.platform === "win32" ? 1 : 2);
    }),
  );
});

describe("browseFolders", () => {
  it.effect("lists only folders, marks git repos, hides dotfolders, and gives the parent", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const listing = yield* browseFolders(`${root}/`);
      expect(listing.path).toBe(root);
      expect(listing.parent).toBeDefined();
      expect(listing.entries).toEqual([
        { name: "Notes", path: join(root, "Notes"), isGitRepo: false },
        { name: "repo-a", path: join(root, "repo-a"), isGitRepo: true },
        { name: "repo-b", path: join(root, "repo-b"), isGitRepo: false },
      ]);
      expect(listing.truncated).toBe(false);
      expect(listing.git).toBeUndefined();
    }),
  );

  it.effect("says what the listed folder's own .git is, as adding it would read it", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      writeFileSync(join(root, "repo-b", ".git"), "gitdir: ../repo-a/.git/worktrees/b");
      expect((yield* browseFolders(join(root, "repo-a/"))).git).toBe("repository");
      expect((yield* browseFolders(join(root, "repo-b/"))).git).toBe("linked");
      expect((yield* browseFolders(join(root, "Notes/"))).git).toBeUndefined();
    }),
  );

  // Windows has no search bit to take away, and root reads anything.
  it.effect.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "says a .git it can't read is unreadable, not absent",
    () =>
      Effect.gen(function* () {
        const root = yield* tempTree;
        const repo = join(root, "repo-a");
        chmodSync(repo, 0o444);
        yield* Effect.addFinalizer(() => Effect.sync(() => chmodSync(repo, 0o755)));
        expect((yield* browseFolders(`${repo}/`)).git).toBe("unreadable");
      }),
  );

  it.effect(
    "completes a typed prefix case-insensitively, and shows dotfolders for a dot prefix",
    () =>
      Effect.gen(function* () {
        const root = yield* tempTree;
        const repos = yield* browseFolders(join(root, "REPO"));
        expect(repos.path).toBe(root);
        expect(repos.entries.map((e) => e.name)).toEqual(["repo-a", "repo-b"]);

        const hidden = yield* browseFolders(join(root, ".h"));
        expect(hidden.entries.map((e) => e.name)).toEqual([".hidden"]);
      }),
  );

  it.effect("expands ~, caps the entries, and fails friendly for a missing folder", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const home = yield* browseFolders("~/", { home: root });
      expect(home.path).toBe(root);

      const capped = yield* browseFolders(`${root}/`, { limit: 2 });
      expect(capped.entries).toHaveLength(2);
      expect(capped.truncated).toBe(true);

      const missing = yield* browseFolders(join(root, "nope", "deeper")).pipe(Effect.flip);
      expect(missing).toEqual(
        new NotFound({
          entity: "project",
          id: join(root, "nope"),
          message: `Folder not found: ${join(root, "nope")}`,
        }),
      );
    }),
  );
});

/** A known project at `root`. */
const knownProject = (id: string, root: string): Project => ({
  id: id as ProjectId,
  root,
  name: root.slice(Math.max(root.lastIndexOf("/"), root.lastIndexOf("\\")) + 1),
  bookmarked: false,
});

describe("reposIn and repositoryCandidates", () => {
  it.effect("finds every repository directly in a folder, past any cap and no deeper", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      // More than the 59 of the C:\git whose picker showed only the 16 already known.
      const names = Array.from({ length: 75 }, (_, i) => `repo-${String(i).padStart(2, "0")}`);
      const code = join(root, "code");
      for (const name of names) mkdirSync(join(code, name, ".git"), { recursive: true });
      mkdirSync(join(code, "plain"));
      mkdirSync(join(code, "group", "nested", ".git"), { recursive: true });
      writeFileSync(join(code, "linked"), "");
      mkdirSync(join(code, "worktree"));
      writeFileSync(join(code, "worktree", ".git"), "gitdir: elsewhere");

      const found = yield* reposIn(code);
      expect(found.toSorted()).toEqual(names.map((name) => join(code, name)));
      expect(yield* reposIn(join(root, "nope"))).toEqual([]);
    }),
  );

  it.effect("lists the known repositories, then each found one once, without a plain folder", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const known = [
        knownProject("p-a", join(root, "repo-a")),
        // A thread started in the folder itself registers it, but no worker can use it.
        knownProject("p-root", root),
      ];
      mkdirSync(join(root, "zeta", ".git"), { recursive: true });
      mkdirSync(join(root, "beta", ".git"), { recursive: true });

      const { repos } = yield* repositoryCandidates(known, [root, `${root}/`]);
      expect(repos).toEqual([
        { name: "repo-a", root: join(root, "repo-a"), projectId: "p-a" },
        { name: "beta", root: join(root, "beta") },
        { name: "zeta", root: join(root, "zeta") },
      ]);
    }),
  );

  describe.skipIf(process.platform !== "win32")("on Windows", () => {
    it.effect("takes a known project spelled C:/GIT/x/ for the C:\\git\\x it finds", () =>
      Effect.gen(function* () {
        const root = yield* tempTree;
        const other = root.replaceAll("\\", "/").toUpperCase();
        const { repos } = yield* repositoryCandidates(
          [knownProject("p-a", `${other}/REPO-A/`)],
          [root],
        );
        expect(repos.map((repo) => repo.projectId ?? repo.root)).toEqual(["p-a"]);
      }),
    );
  });
});

type Call = { bin: string; args: ReadonlyArray<string>; env?: Readonly<Record<string, string>> };
const ok = (stdout = ""): ProcOutput => ({ status: 0, stdout, stderr: "", truncated: false });

/**
 * A `Proc` whose clone writes a repository into the folder it is given, unless `clone` says
 * otherwise, and whose `git config` lists `remotes` for whichever clone it is asked about.
 */
const fakeProc = (
  calls: Array<Call>,
  options: {
    remotes?: string;
    clone?: (into: string) => Effect.Effect<ProcOutput, ProcTimeout>;
  } = {},
): ProcShape => ({
  run: (bin, args, run) =>
    Effect.suspend(() => {
      calls.push({ bin, args, ...(run.env === undefined ? {} : { env: run.env }) });
      if (args[0] === "config") return Effect.succeed(ok(options.remotes ?? ""));
      const into = args.at(-1)!;
      writeFileSync(join(into, "partial"), "");
      if (options.clone !== undefined) return options.clone(into);
      mkdirSync(join(into, ".git"));
      return Effect.succeed(ok());
    }),
});

const clone = (
  store: ReturnType<typeof fakeStore>["store"],
  proc: ProcShape,
  remote: string,
  cloneFolder: string,
  home?: string,
) =>
  cloneRepo(store, { remote, cloneFolder, ...(home === undefined ? {} : { home }) }).pipe(
    Effect.provideService(Proc, proc),
  );

/** A failed clone that said `stderr`. */
const said = (stderr: string) => ({ status: 1, stdout: "", stderr, truncated: false });

describe("cloneRepo", () => {
  it.effect("refuses a bad remote or a relative folder before running anything", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const calls: Array<Call> = [];
      const { store, projects } = fakeStore();
      for (const remote of ["--upload-pack=x/y", "EXAMPLE/..", "https://tok@github.com/a/b"]) {
        const error = yield* clone(store, fakeProc(calls), remote, root).pipe(Effect.flip);
        expect(error, remote).toBeInstanceOf(InvalidState);
      }
      const relative = yield* clone(
        store,
        fakeProc(calls),
        "EXAMPLE/example-device-apps",
        "code",
      ).pipe(Effect.flip);
      expect(relative.message).toContain("not code");
      expect(calls).toEqual([]);
      expect(projects).toEqual([]);
    }),
  );

  it.effect("clones GitHub's owner/repo with gh into <folder>/<repo>, leaving no temp folder", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const calls: Array<Call> = [];
      const { store } = fakeStore();
      const project = yield* clone(
        store,
        fakeProc(calls),
        "EXAMPLE/example-device-apps",
        "~/code",
        root,
      );
      const target = join(root, "code", "example-device-apps");
      expect(project).toMatchObject({
        root: target,
        name: "example-device-apps",
        repoRoot: target,
      });
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call!.bin).toBe("gh");
      expect(call!.args.slice(0, 3)).toEqual(["repo", "clone", "EXAMPLE/example-device-apps"]);
      expect(call!.args[3]).toMatch(/[\\/]\.example-device-apps\.clone-[^\\/]+$/);
      expect(readdirSync(join(root, "code"))).toEqual(["example-device-apps"]);
      expect(readdirSync(target).toSorted()).toEqual([".git", "partial"]);
    }),
  );

  it.effect("clones any other URL with git, after `--` and held to https and ssh", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const calls: Array<Call> = [];
      const url = "git@organization.example.invalid:team/tool.git";
      yield* clone(fakeStore().store, fakeProc(calls), url, root);
      expect(calls[0]).toMatchObject({
        bin: "git",
        args: ["clone", "--", url, expect.stringContaining(".tool.clone-")],
        env: { GIT_ALLOW_PROTOCOL: "https:ssh" },
      });
      expect(readdirSync(join(root, "tool"))).toContain(".git");
    }),
  );

  it.effect("adopts a clone of the same repository already there, however it was spelled", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      mkdirSync(join(root, "example-device-apps", ".git"), { recursive: true });
      const calls: Array<Call> = [];
      const proc = fakeProc(calls, {
        remotes:
          "remote.upstream.url /elsewhere\nremote.origin.url git@github.com:eXaMpLe/EXAMPLE-DEVICE-APPS.git\n",
      });
      const project = yield* clone(
        fakeStore().store,
        proc,
        "https://github.com/EXAMPLE/example-device-apps",
        root,
      );
      expect(project.root).toBe(join(root, "example-device-apps"));
      expect(calls.map((call) => call.args[0])).toEqual(["config"]);
    }),
  );

  it.effect("refuses a folder there that holds another repository or anything else", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const calls: Array<Call> = [];
      const proc = fakeProc(calls, {
        remotes: "remote.origin.url https://github.com/EXAMPLE/other\n",
      });
      const { store, projects } = fakeStore();
      const other = yield* clone(store, proc, "EXAMPLE/repo-a", root).pipe(Effect.flip);
      expect(other).toEqual(
        new InvalidState({
          message: `${join(root, "repo-a")} already exists and isn't a clone of EXAMPLE/repo-a. Move it, or change where new clones go in Settings → General.`,
        }),
      );
      writeFileSync(join(root, "Notes", "todo.md"), "");
      expect(yield* clone(store, proc, "EXAMPLE/Notes", root).pipe(Effect.flip)).toBeInstanceOf(
        InvalidState,
      );
      expect(calls.map((call) => call.args[0])).toEqual(["config"]);
      expect(projects).toEqual([]);
    }),
  );

  it.effect(
    "refuses an empty folder of the repository's name, as another clone's reservation",
    () =>
      Effect.gen(function* () {
        const root = yield* tempTree;
        const calls: Array<Call> = [];
        const error = yield* clone(fakeStore().store, fakeProc(calls), "EXAMPLE/Notes", root).pipe(
          Effect.flip,
        );
        expect(error.message).toContain("already exists, empty, or is being cloned right now");
        expect(readdirSync(join(root, "Notes"))).toEqual([]);
        expect(calls).toEqual([]);
      }),
  );

  it.effect("leaves alone a folder that appears while cloning, or adopts it if it's a clone", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const target = join(root, "example-device-apps");
      const { store, projects } = fakeStore();
      const theirs = fakeProc([], {
        clone: () =>
          Effect.sync(() => {
            writeFileSync(join(target, "theirs.txt"), "");
            return ok();
          }),
      });
      expect(
        yield* clone(store, theirs, "EXAMPLE/example-device-apps", root).pipe(Effect.flip),
      ).toBeInstanceOf(InvalidState);
      expect(readdirSync(target)).toEqual(["theirs.txt"]);
      expect(readdirSync(root).filter((name) => name.includes(".clone-"))).toEqual([]);
      expect(projects).toEqual([]);

      // Nor is an empty folder put in place of the reservation replaced, or removed on the way out.
      rmSync(target, { recursive: true });
      const swapped = fakeProc([], {
        clone: () =>
          Effect.sync(() => {
            // Made while the reservation still exists, so it can't reuse its inode.
            mkdirSync(join(root, "swap"));
            rmSync(target, { recursive: true });
            renameSync(join(root, "swap"), target);
            return ok();
          }),
      });
      expect(
        yield* clone(store, swapped, "EXAMPLE/example-device-apps", root).pipe(Effect.flip),
      ).toBeInstanceOf(InvalidState);
      expect(readdirSync(target)).toEqual([]);

      rmSync(target, { recursive: true });
      const raced = fakeProc([], {
        remotes: "remote.origin.url https://github.com/EXAMPLE/example-device-apps.git\n",
        clone: () =>
          Effect.sync(() => {
            mkdirSync(join(target, ".git"));
            return ok();
          }),
      });
      const project = yield* clone(store, raced, "EXAMPLE/example-device-apps", root);
      expect(project.root).toBe(target);
      expect(readdirSync(target)).toEqual([".git"]);
      expect(readdirSync(root).filter((name) => name.includes(".clone-"))).toEqual([]);
    }),
  );

  it.effect("leaves nothing behind when the clone fails, overruns or is interrupted", () =>
    Effect.gen(function* () {
      const root = yield* tempTree;
      const base = join(root, "code");
      const { store, projects } = fakeStore();
      const failing = fakeProc([], {
        clone: () =>
          Effect.succeed({
            status: 1,
            stdout: "",
            stderr:
              "Cloning into '/x/.nope.clone-1'...\nGraphQL: Could not resolve to a Repository with the name 'EXAMPLE/nope'.\n",
            truncated: false,
          }),
      });
      expect(yield* clone(store, failing, "EXAMPLE/nope", base).pipe(Effect.flip)).toEqual(
        new GitError({
          message:
            "Couldn't clone EXAMPLE/nope: GraphQL: Could not resolve to a Repository with the name 'EXAMPLE/nope'.",
        }),
      );
      expect(readdirSync(base)).toEqual([]);

      const slow = fakeProc([], {
        clone: () => Effect.fail(new ProcTimeout({ bin: "gh", message: "gh timed out" })),
      });
      expect(yield* clone(store, slow, "EXAMPLE/nope", base).pipe(Effect.flip)).toMatchObject({
        message: "Cloning EXAMPLE/nope took longer than 5 minutes, so it was stopped.",
      });
      expect(readdirSync(base)).toEqual([]);

      const cancelled = fakeProc([], { clone: () => Effect.interrupt });
      const exit = yield* clone(store, cancelled, "EXAMPLE/nope", base).pipe(Effect.exit);
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(readdirSync(base)).toEqual([]);
      expect(projects).toEqual([]);
    }),
  );

  it("quotes what the clone said, without its temp folder", () => {
    expect(cloneFailure({ status: 128, stdout: "", stderr: "", truncated: false })).toBe(
      "exited with 128",
    );
  });

  it("quotes a clone failure for a repository it can't see as it is", () => {
    const hidden = [
      "GraphQL: Could not resolve to a Repository with the name 'EXAMPLE/secret'. (repository)",
      "remote: Repository not found.\nfatal: repository 'https://github.com/EXAMPLE/secret/' not found",
      "fatal: unable to access 'https://github.com/EXAMPLE/secret/': The requested URL returned error: 403",
    ];
    for (const stderr of hidden) {
      expect(cloneFailureMessage("EXAMPLE/secret", said(stderr))).toBe(
        `Couldn't clone EXAMPLE/secret: ${stderr.replace(/\s+/g, " ")}`,
      );
    }
    expect(cloneFailureMessage("EXAMPLE/x", said("fatal: early EOF"))).toBe(
      "Couldn't clone EXAMPLE/x: fatal: early EOF",
    );
  });
});

/** `gh api --include` output for a page of `names`, whose `Link` names `last` as the last page. */
const repoPage = (names: ReadonlyArray<string>, last?: number): string =>
  [
    "HTTP/2.0 200 OK",
    ...(last === undefined
      ? []
      : [
          `Link: <https://api.github.com/user/repos?sort=pushed&per_page=100&page=2>; rel="next", <https://api.github.com/user/repos?sort=pushed&per_page=100&page=${last}>; rel="last"`,
        ]),
    "X-Ratelimit-Resource: core",
    "",
    names.join("\n"),
  ].join("\n");

/** A `Proc` answering `user/repos` page `n` with `pages(n)`, counting the calls in `calls`. */
const repoProc = (calls: Array<number>, pages: (page: number) => ProcOutput): ProcShape => ({
  run: (_bin, args) =>
    Effect.sync(() => {
      const page = Number(/&page=(\d+)/.exec(args[1] ?? "")?.[1]);
      calls.push(page);
      return pages(page);
    }),
});

const suggest = (proc: ProcShape, suggestions = makeCloneSuggestions("/")) =>
  suggestions.pipe(Effect.provideService(Proc, proc));

describe("makeCloneSuggestions", () => {
  it("reads the last page from the Link header, else takes one", () => {
    expect(lastPage(repoPage([], 7).split("\n\n")[0])).toBe(7);
    expect(lastPage('Link: <https://api.github.com/x?page=2>; rel="next"')).toBe(1);
    expect(lastPage(undefined)).toBe(1);
  });

  it.effect("asks for every page, keeps the first's order and drops a repeat", () =>
    Effect.gen(function* () {
      const calls: Array<number> = [];
      const proc = repoProc(calls, (page) =>
        ok(
          page === 1
            ? repoPage(["ANT1OFF/gram", "EXAMPLE/example-device-apps"], 3)
            : page === 2
              ? repoPage(["EXAMPLE/example-device-apps", "EXAMPLE/actions-registry-auth"])
              : repoPage(["EXAMPLE/aft-account-customizations"]),
        ),
      );
      const suggestions = makeCloneSuggestions("/");
      expect((yield* suggest(proc, suggestions)).repos).toEqual([
        "ANT1OFF/gram",
        "EXAMPLE/example-device-apps",
        "EXAMPLE/actions-registry-auth",
        "EXAMPLE/aft-account-customizations",
      ]);
      expect(calls.toSorted()).toEqual([1, 2, 3]);
      yield* suggest(proc, suggestions);
      expect(calls).toHaveLength(3);
    }),
  );

  it.effect("stops at twenty pages", () =>
    Effect.gen(function* () {
      const calls: Array<number> = [];
      yield* suggest(repoProc(calls, (page) => ok(repoPage([`o/r${page}`], 500))));
      expect(calls).toHaveLength(20);
    }),
  );

  it.effect("offers nothing when GitHub can't be asked, and keeps no short list", () =>
    Effect.gen(function* () {
      expect(
        (yield* suggest(repoProc([], () => said("HTTP 403: rate limit exceeded")))).repos,
      ).toEqual([]);
      const calls: Array<number> = [];
      const suggestions = makeCloneSuggestions("/");
      const short = repoProc(calls, (page) =>
        page === 1 ? ok(repoPage(["o/a"], 2)) : said("HTTP 502"),
      );
      expect((yield* suggest(short, suggestions)).repos).toEqual(["o/a"]);
      yield* suggest(short, suggestions);
      expect(calls).toHaveLength(4);
    }),
  );
});
