// Gram's own git runs outside any agent sandbox, in folders agents can write. A repository's local
// config (`.git/config`, `config.worktree`, anything they include) can name programs git then runs:
// `core.fsmonitor` on reading the index, a clean filter on `add`, `core.sshCommand` on a fetch. So
// before each git call Gram reads that config, and every key there that names a program is put back
// to the user's own (system or global) value for the call, or switched off. The user's own setup
// keeps working; what a checkout says about itself never runs.

import * as fs from "node:fs";
import { devNull } from "node:os";
import * as nodePath from "node:path";

export interface ConfigEntry {
  readonly scope: string;
  /** As git lists it: section and name lowercased, a subsection as written. */
  readonly key: string;
  /** `undefined` for a bare key (`[core] novalue`), which git reads as true. */
  readonly value: string | undefined;
}

/** `git config --list --show-scope -z`: `scope NUL key LF value NUL`, the LF and value absent for a bare key. */
export const parseConfigList = (out: string): ReadonlyArray<ConfigEntry> => {
  const parts = out.split("\0");
  const entries: Array<ConfigEntry> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i]!;
    const item = parts[i + 1]!;
    const lf = item.indexOf("\n");
    entries.push(
      lf < 0
        ? { scope, key: item, value: undefined }
        : { scope, key: item.slice(0, lf), value: item.slice(lf + 1) },
    );
  }
  return entries;
};

const REPO_SCOPES = new Set(["local", "worktree"]);

const BOOLEAN = /^(?:true|false|yes|no|on|off|1|0)?$/i;

/**
 * What a key that names a program is set to when the repository set it and the user didn't: the
 * value git treats as "nothing to run" where one exists, else the stock program. `undefined` for a
 * key that doesn't name a program.
 */
export const neutralValue = (key: string, value: string | undefined): string | undefined => {
  const k = key.toLowerCase();
  // A plain true/false is git's own built-in monitor, which runs nothing of the repository's.
  if (k === "core.fsmonitor")
    return value === undefined || BOOLEAN.test(value) ? undefined : "false";
  if (k === "core.sshcommand") return "ssh";
  if (k === "core.editor" || k === "sequence.editor") return ":";
  if (k === "core.pager" || /^pager\..+$/.test(k)) return "cat";
  if (
    k === "core.askpass" ||
    k === "core.gitproxy" ||
    k === "core.alternaterefscommand" ||
    k === "interactive.difffilter" ||
    k === "gpg.ssh.defaultkeycommand"
  )
    return "";
  if (k === "gpg.program" || k === "gpg.openpgp.program") return "gpg";
  if (k === "gpg.x509.program") return "gpgsm";
  if (k === "gpg.ssh.program") return "ssh-keygen";
  // An empty helper clears the list; the user's own helpers are added back after it.
  if (k === "credential.helper" || /^credential\..+\.helper$/.test(k)) return "";
  // An empty filter command is no filter.
  if (/^filter\..+\.(?:clean|smudge|process)$/.test(k)) return "";
  // A filter the repository marked required, with its commands gone, would fail every checkout.
  if (/^filter\..+\.required$/.test(k)) return "false";
  // `cat` as a textconv is the file as it is.
  if (/^diff\..+\.textconv$/.test(k)) return "cat";
  // A failing merge driver leaves the conflict for a person, as a merge without one would.
  if (/^merge\..+\.driver$/.test(k)) return "false";
  if (/^remote\..+\.uploadpack$/.test(k)) return "git-upload-pack";
  if (/^remote\..+\.receivepack$/.test(k)) return "git-receive-pack";
  // `commit --trailer` and `interpret-trailers` run a trailer's command; `true` adds nothing.
  if (/^trailer\..+\.(?:cmd|command)$/.test(k)) return "true";
  if (/^(?:difftool|mergetool)\..+\.cmd$/.test(k)) return "false";
  if (/^submodule\..+\.update$/.test(k))
    return value !== undefined && value.startsWith("!") ? "checkout" : undefined;
  return undefined;
};

/** External diff commands can't be given a harmless value, so the call is told not to use them. */
const isExternalDiff = (key: string): boolean => {
  const k = key.toLowerCase();
  return k === "diff.external" || /^diff\..+\.command$/.test(k);
};

const isInclude = (key: string): boolean => {
  const k = key.toLowerCase();
  return k === "include.path" || /^includeif\..+\.path$/.test(k);
};

/**
 * Always set. No hook runs: `$GIT_DIR/hooks` and a `core.hooksPath` are both content a checkout's
 * agent (or whoever planted the repository) can write, and Gram's own merges, fetches, checkouts
 * and commits are not the user's to vet. A remote URL never runs a command through `ext::`,
 * whatever the repository allows. And git never starts a git of its own inside a submodule unless
 * asked on the command line: that one would read the submodule's config, which the guard reads
 * only for the nested repositories it finds. Status and diff still show a submodule's moved commit
 * (`dirty` reads its HEAD in place), not its uncommitted changes.
 */
const ALWAYS: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", devNull],
  ["protocol.ext.allow", "never"],
  ["diff.ignoreSubmodules", "dirty"],
  ["status.submoduleSummary", "false"],
  ["submodule.recurse", "false"],
  ["fetch.recurseSubmodules", "false"],
  ["push.recurseSubmodules", "no"],
];

export interface Guard {
  /** `GIT_CONFIG_*` pairs to add, in order: a later pair for the same key wins. */
  readonly pairs: ReadonlyArray<readonly [string, string]>;
  /** The repository names an external diff, so diffing subcommands get `--no-ext-diff`. */
  readonly noExtDiff: boolean;
  /** The repository's config includes other files, whose changes a cached answer wouldn't see. */
  readonly includes: boolean;
}

/**
 * The guard for one listing: the repository's program keys, put back to the user's values or off.
 * `nested` is what its submodules' own config files hold, as local entries: a git that does start
 * inside one inherits these pairs, which win over that config too.
 */
export const guardFor = (
  entries: ReadonlyArray<ConfigEntry>,
  nested: ReadonlyArray<ConfigEntry> = [],
): Guard => {
  const pairs: Array<readonly [string, string]> = [...ALWAYS];
  let noExtDiff = false;
  let includes = false;
  const handled = new Set<string>();
  // `core.fsmonitor` always, so a nested repository this listing can't see (a submodule's own
  // `.git` folder) runs no monitor of its own either: off, then the user's values, then the
  // repository's own built-in choice (a plain boolean, which runs nothing of its own).
  handled.add("core.fsmonitor");
  pairs.push(["core.fsmonitor", "false"]);
  for (const entry of entries)
    if (entry.key === "core.fsmonitor" && !REPO_SCOPES.has(entry.scope))
      pairs.push([entry.key, entry.value ?? "true"]);
  for (const entry of entries)
    if (
      entry.key === "core.fsmonitor" &&
      REPO_SCOPES.has(entry.scope) &&
      neutralValue(entry.key, entry.value) === undefined
    )
      pairs.push([entry.key, entry.value ?? "true"]);
  for (const entry of [...entries, ...nested]) {
    if (!REPO_SCOPES.has(entry.scope)) continue;
    if (isInclude(entry.key)) includes = true;
    if (isExternalDiff(entry.key)) noExtDiff = true;
    const neutral = neutralValue(entry.key, entry.value);
    if (neutral === undefined || handled.has(entry.key)) continue;
    handled.add(entry.key);
    pairs.push([entry.key, neutral]);
    // The user's own values for the key, in git's order, so the last single value still wins and a
    // list (credential helpers) is rebuilt from the user's entries alone.
    for (const own of entries) {
      if (own.key === entry.key && !REPO_SCOPES.has(own.scope))
        pairs.push([own.key, own.value ?? "true"]);
    }
  }
  return { pairs, noExtDiff, includes };
};

/** `env` with `pairs` as the next `GIT_CONFIG_*` entries after any already set. */
export const appendGitConfig = (
  env: Readonly<Record<string, string>>,
  pairs: ReadonlyArray<readonly [string, string]>,
): Readonly<Record<string, string>> => {
  if (pairs.length === 0) return env;
  // Windows env names are case-insensitive, so an inherited count may be spelled any way.
  const countKey =
    Object.keys(env).find((key) => key.toUpperCase() === "GIT_CONFIG_COUNT") ?? "GIT_CONFIG_COUNT";
  const count = Number.parseInt(env[countKey] ?? "", 10);
  const start = Number.isInteger(count) && count > 0 ? count : 0;
  const next: Record<string, string> = { ...env, [countKey]: String(start + pairs.length) };
  pairs.forEach(([key, value], i) => {
    next[`GIT_CONFIG_KEY_${start + i}`] = key;
    next[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  return next;
};

/** Options git takes before its subcommand, with the ones that take the next argument. */
const GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** How many leading arguments are git's own options, before the subcommand. */
export const leadingOptions = (args: ReadonlyArray<string>): number => {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += GLOBAL_WITH_VALUE.has(args[i]!) ? 2 : 1;
  return Math.min(i, args.length);
};

const DIFFING = new Set(["diff", "log", "show", "whatchanged", "stash"]);

/** `args` with `--no-ext-diff` after a diffing subcommand, when the guard asks for it. */
export const withGuardArgs = (args: ReadonlyArray<string>, guard: Guard): ReadonlyArray<string> => {
  if (!guard.noExtDiff) return args;
  const at = leadingOptions(args);
  const sub = args[at];
  if (sub === undefined || !DIFFING.has(sub)) return args;
  // `stash show` diffs; the flag goes after its own subcommand.
  const insertAt = sub === "stash" ? (args[at + 1] === "show" ? at + 2 : -1) : at + 1;
  if (insertAt < 0) return args;
  return [...args.slice(0, insertAt), "--no-ext-diff", ...args.slice(insertAt)];
};

// ---------------------------------------------------------------------------------------------
// Submodules

const SUBMODULE_LIMIT = 64;

/**
 * The git folders of the repository's submodules, nested ones too: `<common dir>/modules/<name>`,
 * where `git submodule` keeps them. A name may hold slashes, so a folder without a `HEAD` is walked
 * into. `undefined` past `SUBMODULE_LIMIT`, which the caller treats as unreadable.
 */
export const submoduleGitDirs = (commonDir: string): ReadonlyArray<string> | undefined => {
  const found: Array<string> = [];
  const walk = (folder: string, depth: number): boolean => {
    let names: Array<fs.Dirent>;
    try {
      names = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const path = nodePath.join(folder, entry.name);
      if (fs.existsSync(nodePath.join(path, "HEAD"))) {
        found.push(path);
        if (found.length > SUBMODULE_LIMIT) return false;
        if (!walk(nodePath.join(path, "modules"), 0)) return false;
      } else if (depth < 8 && !walk(path, depth + 1)) return false;
    }
    return true;
  };
  return walk(nodePath.join(commonDir, "modules"), 0) ? found : undefined;
};

/** Index entries `git ls-files -s -z` lists as gitlinks (mode 160000): a nested repository's path. */
export const gitlinkPaths = (out: string): ReadonlyArray<string> => {
  const paths: Array<string> = [];
  for (const record of out.split("\0")) {
    if (!record.startsWith("160000 ")) continue;
    const tab = record.indexOf("\t");
    if (tab >= 0) paths.push(record.slice(tab + 1));
  }
  return paths;
};

/**
 * The git folder of a nested repository checked out at `path`: its own `.git` folder, or the one a
 * `.git` file points to (`gitdir: <path>`, relative to the file). `undefined` when there is none,
 * which is a gitlink git won't start in: nothing is checked out there.
 */
export const nestedGitDir = (path: string): string | undefined => {
  const dotGit = nodePath.join(path, ".git");
  let st: fs.Stats;
  try {
    // Followed, as git follows a `.git` that is a link to a folder or to a gitdir file.
    st = fs.statSync(dotGit);
  } catch {
    return undefined;
  }
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return undefined;
  const text = fs.readFileSync(dotGit, "utf8");
  const match = /^gitdir: (.+?)\r?\n?$/m.exec(text);
  return match === null ? undefined : nodePath.resolve(path, match[1]!);
};

/** A submodule git folder's config files, in the order git reads them. */
export const submoduleConfigFiles = (gitDir: string): ReadonlyArray<string> => [
  nodePath.join(gitDir, "config"),
  nodePath.join(gitDir, "config.worktree"),
];

// ---------------------------------------------------------------------------------------------
// What a cached guard depends on

/**
 * What decides which repository git finds from `cwd`, and what its local config says: every
 * ancestor's `.git` and `HEAD` (a bare layout), the git dirs' `commondir`, and the config files.
 * Directories by inode only, since git writes inside them all the time; files by inode, change
 * time and size, since a change time can't be set back.
 */
export const discoverySignature = (
  cwd: string,
  gitDir: string,
  commonDir: string,
  lstat: (path: string) => fs.BigIntStats | undefined = lstatOrUndefined,
  nestedGitDirs: ReadonlyArray<string> = [],
  gitlinkDotGits: ReadonlyArray<string> = [],
): string => {
  const parts: Array<string> = [];
  const mark = (path: string) => {
    const st = lstat(path);
    if (st === undefined) parts.push(`${path}:-`);
    else if (st.isDirectory()) parts.push(`${path}:d${st.ino}`);
    else parts.push(`${path}:${st.ino}:${st.ctimeNs}:${st.size}`);
  };
  let dir = nodePath.resolve(cwd);
  for (;;) {
    mark(nodePath.join(dir, ".git"));
    mark(nodePath.join(dir, "HEAD"));
    const parent = nodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const path of [
    nodePath.join(gitDir, "commondir"),
    nodePath.join(gitDir, "config.worktree"),
    nodePath.join(commonDir, "config"),
    nodePath.join(commonDir, "config.worktree"),
    // A gitlink added to the index is a nested repository whose config the guard has to read.
    nodePath.join(gitDir, "index"),
  ])
    mark(path);
  for (const nested of nestedGitDirs) {
    mark(nested);
    mark(nodePath.join(nested, "index"));
    for (const path of submoduleConfigFiles(nested)) mark(path);
  }
  // Every gitlink's `.git`, checked out or not: one made later at a gitlink nothing was checked
  // out at is a nested repository whose config the guard hasn't read. Followed too, so a link
  // pointed elsewhere changes the signature.
  for (const path of gitlinkDotGits) {
    mark(path);
    const target = statOrUndefined(path);
    parts.push(
      target === undefined
        ? `${path}=>-`
        : target.isDirectory()
          ? `${path}=>d${target.ino}`
          : `${path}=>${target.ino}:${target.ctimeNs}:${target.size}`,
    );
  }
  const submodules = submoduleGitDirs(commonDir);
  if (submodules === undefined) parts.push("submodules:too-many");
  else for (const sub of submodules) for (const path of submoduleConfigFiles(sub)) mark(path);
  return parts.join("\n");
};

const statOrUndefined = (path: string): fs.BigIntStats | undefined => {
  try {
    return fs.statSync(path, { bigint: true });
  } catch {
    return undefined;
  }
};

const lstatOrUndefined = (path: string): fs.BigIntStats | undefined => {
  try {
    return fs.lstatSync(path, { bigint: true });
  } catch {
    return undefined;
  }
};

/** The env a guard's answer depends on: everything git reads its config and repository from. */
export const gitEnvKey = (env: Readonly<Record<string, string>>): string =>
  Object.keys(env)
    .filter((name) => name.toUpperCase().startsWith("GIT_"))
    .toSorted()
    .map((name) => `${name}=${env[name]}`)
    .join("\0");
