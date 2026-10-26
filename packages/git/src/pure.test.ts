import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { porcelainChanges, porcelainPath } from "./exec.ts";
import { classifyUpstream, fetchRedundant, notARepoState } from "./git-state.ts";
import { fetchDue } from "./git-state-runtime.ts";
import { composeBranch, randomWorktreeName } from "./names.ts";
import {
  basename,
  expandHome,
  fromGitPath,
  isInside,
  isPhysicallyInside,
  isStrictlyInside,
  physicalPathAsync,
  realPathOrOwned,
  relativeInside,
  tryRealPath,
  tryRealPathSync,
  physicalPath,
  projectRoot,
  projectRootKey,
  samePath,
  samePathKey,
} from "./paths.ts";
import { childEnv, parsePathProbe, resolveExecutable, withGitLongPaths } from "./proc.ts";
import { cacheFresh, findOnPath } from "./tools.ts";
import { classifyPath, cooldownDelay, type Classification, type WatchedCheckout } from "./watch.ts";
import { includePatterns, matchesInclude } from "./worktree-include.ts";
import {
  checkoutInUse,
  folderName,
  matchesDirtyStderr,
  parseWorktrees,
  sanitizeBranch,
} from "./worktrees.ts";

const classify = (path: string, checkouts: ReadonlyArray<WatchedCheckout>): Classification => {
  const out: Classification = { hit: new Set(), internal: new Set() };
  classifyPath(path, checkouts, out, () => undefined);
  return out;
};

const existing =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

describe("long git text runs", () => {
  it("scans path separators, quotes and PATH directories without retrying suffixes", () => {
    const quotes = '"'.repeat(100_000);
    const separators = "/\\".repeat(50_000);
    const started = performance.now();
    expect(porcelainPath(`?? file${quotes}x`)).toBe(`file${quotes}x`);
    expect(porcelainPath(`?? ${quotes}file${quotes}`)).toBe("file");
    expect(porcelainPath(`?? ${quotes}`)).toBeUndefined();
    expect(basename(`/repo/${separators}leaf`)).toBe("leaf");
    expect(basename(`/repo/leaf${separators}`)).toBe("leaf");
    expect(basename(separators)).toBe("");
    const dir = `C:\\bin${separators}x`;
    const executable = `${dir}\\git.exe`;
    expect(resolveExecutable("git", "win32", dir, existing(executable), ".EXE")).toBe(executable);
    expect(
      resolveExecutable(
        "git",
        "win32",
        `C:\\bin${separators}`,
        existing("C:\\bin\\git.exe"),
        ".EXE",
      ),
    ).toBe("C:\\bin\\git.exe");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("names", () => {
  it("composes adjective-animal-hex", () => {
    expect(randomWorktreeName()).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{6}$/);
    expect(randomWorktreeName(() => 0)).toBe("bouncy-alpaca-000000");
  });

  it("composes a prefix without doubling it", () => {
    expect(composeBranch("", "x")).toBe("x");
    expect(composeBranch("feat", " x ")).toBe("feat/x");
    expect(composeBranch("feat", "feat/x")).toBe("feat/x");
    expect(composeBranch("fix", "/x")).toBe("fix/x");
    expect(composeBranch("feat", "")).toBe("");
  });
});

describe("branch sanitising and placement names", () => {
  it("gates the charset", () => {
    expect(sanitizeBranch("feature/x-1.2_y")).toBe("feature/x-1.2_y");
    for (const bad of ["", "bad branch", "-evil", "tick`tick", "semi;colon", "ünïcode"]) {
      expect(sanitizeBranch(bad)).toBeUndefined();
    }
  });

  it("flattens slashes", () => {
    expect(folderName("feature/x/y")).toBe("feature-x-y");
  });

  it("prefixes names Windows reserves for devices, alone or before an extension", () => {
    expect(folderName("aux")).toBe("wt-aux");
    expect(folderName("CON.fix")).toBe("wt-CON.fix");
    expect(folderName("com1")).toBe("wt-com1");
    for (const ordinary of ["console", "aux-tools", "com10", "lpt0", "nul/x"]) {
      expect(folderName(ordinary)).toBe(ordinary.replaceAll("/", "-"));
    }
  });

  it("recognises English dirty refusals only", () => {
    for (const en of [
      "fatal: 'wt' contains modified or untracked files, use --force to delete it",
      "fatal: 'wt' is locked",
      "fatal: '.worktrees/b' is not empty",
    ]) {
      expect(matchesDirtyStderr(en)).toBe(true);
    }
    expect(matchesDirtyStderr("fatal: 'wt' enthält geänderte oder unverfolgte Dateien")).toBe(
      false,
    );
  });
});

describe("worktree list parsing", () => {
  it("keeps order, strips refs, flags detached and drops bare", () => {
    const stdout =
      "worktree /repo\r\nHEAD aaa\r\nbranch refs/heads/master\r\n\r\n" +
      "worktree /repo/.worktrees/wt\r\nHEAD bbb\r\nbranch refs/heads/feat/x\r\n\r\n" +
      "worktree /repo/.worktrees/det\r\nHEAD ccc\r\ndetached\r\n\r\n";
    expect(parseWorktrees(stdout)).toEqual([
      { path: "/repo", branch: "master", detached: false },
      { path: "/repo/.worktrees/wt", branch: "feat/x", detached: false },
      { path: "/repo/.worktrees/det", branch: undefined, detached: true },
    ]);
    const bare =
      "worktree /bare\nbare\n\nHEAD ddd\nbranch refs/heads/orphan\n\nworktree /bare/wt\nHEAD eee\nbranch refs/heads/only\n";
    expect(parseWorktrees(bare)).toEqual([{ path: "/bare/wt", branch: "only", detached: false }]);
    expect(parseWorktrees("")).toEqual([]);
  });
});

describe("containment", () => {
  it("accepts the root and paths under it, and nothing that climbs out", () => {
    const root = nodePath.resolve("/checkout");
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, nodePath.join(root, "a", "b"))).toBe(true);
    expect(isInside(root, nodePath.join(root, "..foo"))).toBe(true);
    expect(isInside(root, nodePath.resolve("/checkout-sibling"))).toBe(false);
    expect(isInside(root, nodePath.resolve("/"))).toBe(false);
    expect(isInside(root, nodePath.resolve("/other/checkout"))).toBe(false);
  });

  it("reads a name that starts with two dots as inside, and only the root itself as not strictly inside", () => {
    const root = nodePath.resolve("/checkout");
    expect(relativeInside(root, nodePath.join(root, "..build", "x"))).toBe(
      nodePath.join("..build", "x"),
    );
    expect(relativeInside(root, root)).toBe("");
    expect(relativeInside(root, nodePath.resolve("/checkout/../other"))).toBeUndefined();
    expect(isStrictlyInside(root, nodePath.join(root, "..build"))).toBe(true);
    expect(isStrictlyInside(root, root)).toBe(false);
    expect(isStrictlyInside(root, nodePath.resolve("/"))).toBe(false);
  });

  it("refuses another Windows drive, which `relative` answers with an absolute path", () => {
    expect(isInside("C:\\repo", "D:\\repo\\x", nodePath.win32)).toBe(false);
    expect(isInside("C:\\repo", "c:\\repo\\..x", nodePath.win32)).toBe(true);
    expect(relativeInside("C:\\repo", "C:\\repo\\..", nodePath.win32)).toBeUndefined();
  });
});

describe("include globs", () => {
  it("matches bare names at any depth, anchored paths from the root, and skips comments", () => {
    const patterns = includePatterns("# secrets\n\n.env\n/config/secret.key\n*.pem\n");
    expect(matchesInclude(patterns, ".env")).toBe(true);
    expect(matchesInclude(patterns, "apps/web/.env")).toBe(true);
    expect(matchesInclude(patterns, "config/secret.key")).toBe(true);
    expect(matchesInclude(patterns, "nested/config/secret.key")).toBe(false);
    expect(matchesInclude(patterns, "certs/dev.pem")).toBe(true);
    expect(matchesInclude(patterns, "scratch.txt")).toBe(false);
    expect(includePatterns("# only\n\n")).toEqual([]);
  });
});

describe("porcelain helpers", () => {
  it("counts non-blank lines, CR-tolerant", () => {
    expect(
      porcelainChanges(' M src/a.rs\r\nR  old.rs -> new.rs\r\n?? "spaced name.rs"\r\n\r\n'),
    ).toBe(3);
    expect(porcelainChanges("\n  \n\r\n")).toBe(0);
  });

  it("extracts the working-tree path", () => {
    expect(porcelainPath(" M src/a.rs")).toBe("src/a.rs");
    expect(porcelainPath("?? new.rs")).toBe("new.rs");
    expect(porcelainPath("R  old.rs -> new.rs")).toBe("new.rs");
    expect(porcelainPath('R  old.rs -> "new name.rs"')).toBe("new name.rs");
    expect(porcelainPath('?? "spaced name.rs"')).toBe("spaced name.rs");
    expect(porcelainPath("?? a -> b.txt")).toBe("a -> b.txt");
    expect(porcelainPath(' M "a -> b.txt"')).toBe("a -> b.txt");
    expect(porcelainPath("")).toBeUndefined();
    expect(porcelainPath("M")).toBeUndefined();
    expect(porcelainPath("   ")).toBeUndefined();
  });
});

const tempFolder = () =>
  fs.realpathSync.native(fs.mkdtempSync(nodePath.join(os.tmpdir(), "gram-paths-")));

describe("paths", () => {
  it("takes two spellings of a folder for one only where its volume ignores case", () => {
    const base = tempFolder();
    try {
      const repo = nodePath.join(base, "Repo");
      fs.mkdirSync(nodePath.join(repo, "A"), { recursive: true });
      const other = nodePath.join(base, "REPO", "a");
      const folds = fs.existsSync(other) && physicalPath(other) === nodePath.join(repo, "A");
      if (!folds) fs.mkdirSync(other, { recursive: true });
      expect(samePath(nodePath.join(repo, "A"), other)).toBe(folds);
      expect(samePathKey(nodePath.join(repo, "A")) === samePathKey(other)).toBe(folds);
      expect(checkoutInUse([nodePath.join(repo, "A")], other)).toBe(folds);
      // A missing folder under a folder that resolves is placed by the folder's real spelling.
      expect(samePath(nodePath.join(repo, "new"), nodePath.join(base, "REPO", "new"))).toBe(folds);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "resolves a link above a path that doesn't exist yet",
    () => {
      const base = tempFolder();
      try {
        fs.mkdirSync(nodePath.join(base, "real"));
        fs.symlinkSync(nodePath.join(base, "real"), nodePath.join(base, "alias"));
        expect(physicalPath(nodePath.join(base, "alias", "new", "deeper"))).toBe(
          nodePath.join(base, "real", "new", "deeper"),
        );
        expect(
          samePath(nodePath.join(base, "alias", "new"), nodePath.join(base, "real", "new")),
        ).toBe(true);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "places a path inside a root by where both really are, linked or not",
    async () => {
      const base = tempFolder();
      try {
        fs.mkdirSync(nodePath.join(base, "real", "sub"), { recursive: true });
        fs.mkdirSync(nodePath.join(base, "elsewhere"));
        fs.symlinkSync(nodePath.join(base, "real"), nodePath.join(base, "alias"));
        fs.symlinkSync(nodePath.join(base, "elsewhere"), nodePath.join(base, "real", "out"));
        const real = nodePath.join(base, "real");
        const alias = nodePath.join(base, "alias");
        // The canonical path of a file inside a root opened through a link is inside it (F12).
        expect(await isPhysicallyInside(alias, nodePath.join(real, "sub", "new.txt"))).toBe(true);
        expect(await isPhysicallyInside(real, nodePath.join(alias, "sub"))).toBe(true);
        // A link out of the root is outside, whether or not its target exists.
        expect(await isPhysicallyInside(real, nodePath.join(real, "out", "x"))).toBe(false);
        expect(await isPhysicallyInside(nodePath.join(base, "gone"), real)).toBe(false);
        expect(await physicalPathAsync(nodePath.join(alias, "new", "deeper"))).toBe(
          physicalPath(nodePath.join(alias, "new", "deeper")),
        );
        expect(await realPathOrOwned(nodePath.join(base, "gone"))).toBe(
          nodePath.join(base, "gone"),
        );
        expect(await tryRealPath(nodePath.join(base, "gone"))).toBeUndefined();
        expect(tryRealPathSync(alias)).toBe(real);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it("compares spellings and expands home", () => {
    // Windows folds case and separators even where the spelling doesn't resolve; elsewhere case counts.
    expect(samePath("/no/such/dir-cc/", "/NO/SUCH/DIR-CC", "win32")).toBe(true);
    expect(samePath("C:\\code\\x", "C:/code/x", "win32")).toBe(true);
    expect(samePath("/no/such/dir-cc/", "/no/such/dir-cc", "linux")).toBe(true);
    expect(samePath("/no/such/dir-cc", "/NO/SUCH/DIR-CC", "linux")).toBe(false);
    expect(samePath("/no/such/dir-cc", "/NO/SUCH/DIR-CC", "darwin")).toBe(false);
    expect(samePath("/a/b", "/a/c")).toBe(false);
    expect(basename("/a/b/")).toBe("b");
    expect(expandHome("~", "/home/me")).toBe("/home/me");
    expect(expandHome("~/projects", "/home/me")).toBe(nodePath.join("/home/me", "projects"));
    expect(expandHome("/var/tmp", "/home/me")).toBe("/var/tmp");
  });

  it("spells git's forward-slash paths natively", () => {
    expect(fromGitPath("C:/Users/me/repo/.worktrees/x", nodePath.win32)).toBe(
      "C:\\Users\\me\\repo\\.worktrees\\x",
    );
    expect(fromGitPath("/home/me/repo", nodePath.posix)).toBe("/home/me/repo");
  });

  it("spells a Windows project root one way, and keys its spellings as one folder", () => {
    for (const spelling of [
      "C:/Git/x",
      "C:\\Git\\x\\",
      "c:\\Git\\x",
      "C:/Git//x/",
      "C:\\Git\\.\\x",
    ]) {
      expect(projectRoot(spelling, "win32"), spelling).toBe("C:\\Git\\x");
    }
    expect(projectRoot("C:/", "win32")).toBe("C:\\");
    expect(projectRoot("\\\\server\\share\\repo\\", "win32")).toBe("\\\\server\\share\\repo");
    expect(projectRoot("/repo/", "win32")).toBe("/repo");
    expect(projectRootKey("C:\\git\\aws_multi_account", "win32")).toBe(
      projectRootKey("C:/Git/aws_multi_account/", "win32"),
    );
    expect(projectRootKey("C:\\git\\a", "win32")).not.toBe(projectRootKey("C:\\git\\b", "win32"));
  });

  it("keeps case in a project root's key where paths are case-sensitive", () => {
    expect(projectRoot("/home/me/repo/", "linux")).toBe("/home/me/repo");
    expect(projectRoot("/", "linux")).toBe("/");
    expect(projectRootKey("/home/me/Repo", "linux")).not.toBe(
      projectRootKey("/home/me/repo", "linux"),
    );
    expect(projectRootKey("/Users/me/Repo", "darwin")).toBe("/Users/me/Repo");
  });
});

describe("proc helpers", () => {
  it("parses the PATH probe between markers despite rc noise", () => {
    expect(parsePathProbe("welcome!\n__SB_PATH__/a:/b__SB_PATH__\n")).toBe("/a:/b");
    expect(parsePathProbe("no markers")).toBeUndefined();
    expect(parsePathProbe("__SB_PATH____SB_PATH__")).toBeUndefined();
  });

  it("resolves .exe directly on Windows only", () => {
    expect(resolveExecutable("git", "win32", "C:\\Windows;C:\\Git\\cmd\\", winGit)).toBe(
      "C:\\Git\\cmd\\git.exe",
    );
    expect(resolveExecutable("git", "darwin", "/usr/bin", winGit)).toBe("git");
    expect(resolveExecutable("C:\\x\\git.exe", "win32", "C:\\Git\\cmd", winGit)).toBe(
      "C:\\x\\git.exe",
    );
    expect(resolveExecutable("missing", "win32", "C:\\Git\\cmd", winGit)).toBe("missing");
  });

  it("sets the probed PATH and disables terminal prompts", () => {
    const env = childEnv(
      { HOME: "/h", PATH: "/usr/bin", GONE: undefined },
      "/opt/bin:/usr/bin",
      "darwin",
    );
    expect(env).toEqual({ HOME: "/h", PATH: "/opt/bin:/usr/bin", GIT_TERMINAL_PROMPT: "0" });
    expect(childEnv({ Path: "C:\\x" }, "C:\\y", "win32")).toEqual({
      Path: "C:\\x",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("adds core.longpaths for git on Windows after any GIT_CONFIG pairs already set", () => {
    expect(withGitLongPaths({ Path: "C:\\x" }, "C:\\Git\\cmd\\git.exe", "win32")).toEqual({
      Path: "C:\\x",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.longpaths",
      GIT_CONFIG_VALUE_0: "true",
    });
    const caller = {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
      GIT_CONFIG_KEY_1: "user.name",
      GIT_CONFIG_VALUE_1: "t",
    };
    expect(withGitLongPaths(caller, "git", "win32")).toEqual({
      ...caller,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "core.longpaths",
      GIT_CONFIG_VALUE_2: "true",
    });
    // An inherited count spelled another way is bumped under its own name.
    expect(
      withGitLongPaths(
        { Git_Config_Count: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" },
        "C:\\GIT\\BIN\\GIT.EXE",
        "win32",
      ),
    ).toEqual({
      Git_Config_Count: "2",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_VALUE_0: "c",
      GIT_CONFIG_KEY_1: "core.longpaths",
      GIT_CONFIG_VALUE_1: "true",
    });
  });

  it("leaves other executables and platforms alone", () => {
    const env = { PATH: "/usr/bin" };
    expect(withGitLongPaths(env, "C:\\Program Files\\GitHub CLI\\gh.exe", "win32")).toBe(env);
    expect(withGitLongPaths(env, "C:\\tools\\gitleaks.exe", "win32")).toBe(env);
    expect(withGitLongPaths(env, "/usr/bin/git", "darwin")).toBe(env);
  });
});

const winGit = (p: string) => p === "C:\\Git\\cmd\\git.exe";

describe("tool probes", () => {
  it("trusts success long and failure briefly", () => {
    const now = 1_000_000;
    expect(cacheFresh(now, true, now, 300_000, 15_000)).toBe(true);
    expect(cacheFresh(now - 60_000, true, now, 300_000, 15_000)).toBe(true);
    expect(cacheFresh(now - 60_000, false, now, 300_000, 15_000)).toBe(false);
    expect(cacheFresh(now - 600_000, true, now, 300_000, 15_000)).toBe(false);
  });

  it("finds tools on PATH, honouring PATHEXT on Windows", () => {
    const posix = new Set(["/opt/bin/claude"]);
    expect(findOnPath("claude", "/usr/bin:/opt/bin", "darwin", "", (p) => posix.has(p))).toBe(
      "/opt/bin/claude",
    );
    expect(
      findOnPath("gh", "/usr/bin:/opt/bin", "darwin", "", (p) => posix.has(p)),
    ).toBeUndefined();
    const win = new Set(["C:\\npm\\claude.CMD"]);
    expect(
      findOnPath("claude", "C:\\Windows;C:\\npm", "win32", ".EXE;.CMD", (p) => win.has(p)),
    ).toBe("C:\\npm\\claude.CMD");
    // npm's global install: the bare `claude` is a /bin/sh script Windows can't run.
    const npm = new Set(["c:\\npm\\claude", "c:\\npm\\claude.cmd", "c:\\npm\\claude.ps1"]);
    expect(
      findOnPath("claude", "C:\\Windows;C:\\npm", "win32", ".COM;.EXE;.BAT;.CMD", (p) =>
        npm.has(p.toLowerCase()),
      ),
    ).toBe("C:\\npm\\claude.CMD");
    expect(
      findOnPath("claude.cmd", "C:\\npm", "win32", ".COM;.EXE;.BAT;.CMD", (p) =>
        npm.has(p.toLowerCase()),
      ),
    ).toBe("C:\\npm\\claude.cmd");
    expect(
      findOnPath("claude", "C:\\npm", "win32", ".EXE", (p) => npm.has(p.toLowerCase())),
    ).toBeUndefined();
  });

  it("resolves claude.cmd, claude.exe and bare names for Proc like PATHEXT", () => {
    const PATH =
      "C:\\Windows\\System32;C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Program Files\\GitHub CLI";
    const PATHEXT = ".COM;.EXE;.BAT;.CMD";
    expect(
      resolveExecutable(
        "claude",
        "win32",
        PATH,
        existing("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"),
        PATHEXT,
      ),
    ).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd");
    expect(
      resolveExecutable(
        "claude",
        "win32",
        PATH,
        existing(
          "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
          "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe",
        ),
        PATHEXT,
      ),
    ).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe");
    expect(
      resolveExecutable(
        "gh",
        "win32",
        PATH,
        existing("C:\\Program Files\\GitHub CLI\\gh.exe"),
        PATHEXT,
      ),
    ).toBe("C:\\Program Files\\GitHub CLI\\gh.exe");
    expect(resolveExecutable("claude", "win32", PATH, existing(), PATHEXT)).toBe("claude");
    expect(resolveExecutable("claude.cmd", "win32", PATH, existing(), PATHEXT)).toBe("claude.cmd");
    expect(resolveExecutable("claude", "darwin", "/usr/bin", existing(), PATHEXT)).toBe("claude");
  });
});

describe("upstream and fetch tiers", () => {
  it("classifies divergence", () => {
    expect(classifyUpstream(0, 0)).toBe("synced");
    expect(classifyUpstream(2, 0)).toBe("behind");
    expect(classifyUpstream(0, 3)).toBe("ahead");
    expect(classifyUpstream(1, 1)).toBe("diverged");
    expect(notARepoState.repo).toBe(false);
  });

  it("skips a fetch only when base and head are both provably current", () => {
    expect(fetchRedundant("aaa", "bbb", "ccc", "ccc")).toBe(false);
    expect(fetchRedundant(undefined, "bbb", "ccc", "ccc")).toBe(false);
    expect(fetchRedundant("aaa", "aaa", undefined, undefined)).toBe(true);
    expect(fetchRedundant("aaa", "aaa", "ccc", undefined)).toBe(true);
    expect(fetchRedundant("aaa", "aaa", "ccc", "ccc")).toBe(true);
    expect(fetchRedundant("aaa", "aaa", "ccc", "ddd")).toBe(false);
    expect(fetchRedundant("aaa", "aaa", undefined, "ccc")).toBe(false);
  });

  it("throttles fetches per repo", () => {
    const last = new Map<string, number>();
    expect(fetchDue(last, "/repo/.git", 0, 45_000)).toBe(true);
    expect(fetchDue(last, "/repo/.git", 10_000, 45_000)).toBe(false);
    expect(fetchDue(last, "/other/.git", 10_000, 45_000)).toBe(true);
    expect(fetchDue(last, "/repo/.git", 45_000, 45_000)).toBe(true);
  });
});

describe("watch classification", () => {
  const main: WatchedCheckout = {
    path: "/repo",
    common: "/repo/.git",
    top: "/repo",
    gitDir: "/repo/.git",
  };

  it("records git-internal hits for the common dir", () => {
    const internal = classify("/repo/.git/HEAD", [main]);
    expect([...internal.hit]).toEqual(["/repo"]);
    expect([...internal.internal]).toEqual(["/repo"]);
    const edit = classify("/repo/src/main.rs", [main]);
    expect([...edit.hit]).toEqual(["/repo"]);
    expect(edit.internal.size).toBe(0);
  });

  it("attributes a nested worktree edit to the longest prefix", () => {
    const wt: WatchedCheckout = {
      path: "/repo/.worktrees/feat",
      common: "/repo/.git",
      top: "/repo/.worktrees/feat",
      gitDir: "/repo/.git/worktrees/feat",
    };
    expect([...classify("/repo/.worktrees/feat/src/x.rs", [main, wt]).hit]).toEqual([
      "/repo/.worktrees/feat",
    ]);
  });

  it("hits every sibling sharing a common dir", () => {
    const wt: WatchedCheckout = {
      path: "/repo/.worktrees/feat",
      common: "/repo/.git",
      top: "/repo/.worktrees/feat",
      gitDir: "/repo/.git/worktrees/feat",
    };
    expect([...classify("/repo/.git/refs/heads/feat", [main, wt]).internal].toSorted()).toEqual([
      "/repo",
      "/repo/.worktrees/feat",
    ]);
  });

  it("routes a checkout's own git files to it alone, and checkpoint refs to nobody", () => {
    const feat: WatchedCheckout = {
      path: "/repo/.worktrees/feat",
      common: "/repo/.git",
      top: "/repo/.worktrees/feat",
      gitDir: "/repo/.git/worktrees/feat",
    };
    const other: WatchedCheckout = {
      ...feat,
      path: "/w/other",
      top: "/w/other",
      gitDir: "/repo/.git/worktrees/other",
    };
    const all = [main, feat, other];
    const hits = (path: string) => [...classify(path, all).internal].toSorted();
    expect(hits("/repo/.git/worktrees/feat/index")).toEqual(["/repo/.worktrees/feat"]);
    expect(hits("/repo/.git/worktrees/feat/index.lock")).toEqual(["/repo/.worktrees/feat"]);
    expect(hits("/repo/.git/worktrees/other/HEAD")).toEqual(["/w/other"]);
    expect(hits("/repo/.git/worktrees/gone/HEAD")).toEqual([]);
    for (const own of [
      "index",
      "index.lock",
      "HEAD",
      "ORIG_HEAD",
      "logs/HEAD",
      "rebase-merge/done",
    ]) {
      expect(hits(`/repo/.git/${own}`)).toEqual(["/repo"]);
    }
    expect(hits("/repo/.git/refs/gram/checkpoints/t/turn.end")).toEqual([]);
    expect(hits("/repo/.git/logs/refs/gram/checkpoints/t/turn")).toEqual([]);
    for (const shared of ["refs/heads/feat", "packed-refs", "config", "logs/refs/heads/main"]) {
      expect(hits(`/repo/.git/${shared}`)).toEqual(["/repo", "/repo/.worktrees/feat", "/w/other"]);
    }
    // Claimed, so the working-tree pass doesn't route it to the main checkout's toplevel.
    expect(classify("/repo/.git/worktrees/gone/HEAD", all).hit.size).toBe(0);
  });

  it("prunes build dirs below the toplevel but not above it", () => {
    for (const pruned of [
      "node_modules",
      "target",
      "build",
      "dist",
      "__pycache__",
      "obj",
      ".venv",
    ]) {
      expect(classify(`/repo/${pruned}/x`, [main]).hit.size).toBe(0);
    }
    const underBuild: WatchedCheckout = {
      path: "/home/u/build/myapp",
      common: "/home/u/build/myapp/.git",
      top: "/home/u/build/myapp",
      gitDir: "/home/u/build/myapp/.git",
    };
    expect(classify("/home/u/build/myapp/src/main.rs", [underBuild]).hit.size).toBe(1);
  });

  it("retries a path through its canonical spelling", () => {
    const out: Classification = { hit: new Set(), internal: new Set() };
    classifyPath(
      "/var/x/repo/a.txt",
      [
        {
          path: "/private/var/x/repo",
          common: "/private/var/x/repo/.git",
          top: "/private/var/x/repo",
          gitDir: "/private/var/x/repo/.git",
        },
      ],
      out,
      (p) => `/private${p}`,
    );
    expect([...out.hit]).toEqual(["/private/var/x/repo"]);
  });

  it("computes the throttle's remaining cooldown", () => {
    expect(cooldownDelay(undefined, 1_000, 2_000)).toBe(0);
    expect(cooldownDelay(1_000, 1_500, 2_000)).toBe(1_500);
    expect(cooldownDelay(1_000, 3_000, 2_000)).toBe(0);
  });
});
