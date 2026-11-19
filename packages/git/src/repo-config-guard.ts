// Gram's own git runs outside any agent sandbox, in folders agents can write. A repository's local
// config (`.git/config`, `config.worktree`, anything they include) can name programs git then runs:
// `core.fsmonitor` on reading the index, a clean filter on `add`, `core.sshCommand` on a fetch. So
// before each git call Gram reads that config, and every key there that names a program is put back
// to the user's own (system or global) value for the call, or switched off. The user's own setup
// keeps working; what a checkout says about itself never runs.

import * as fs from "node:fs";
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

/** Always set: a remote URL never runs a command through `ext::`, whatever the repository allows. */
const ALWAYS: ReadonlyArray<readonly [string, string]> = [["protocol.ext.allow", "never"]];

export interface Guard {
  /** `GIT_CONFIG_*` pairs to add, in order: a later pair for the same key wins. */
  readonly pairs: ReadonlyArray<readonly [string, string]>;
  /** The repository names an external diff, so diffing subcommands get `--no-ext-diff`. */
  readonly noExtDiff: boolean;
  /** The repository's config includes other files, whose changes a cached answer wouldn't see. */
  readonly includes: boolean;
}

/** The guard for one listing: the repository's program keys, put back to the user's values or off. */
export const guardFor = (entries: ReadonlyArray<ConfigEntry>): Guard => {
  const pairs: Array<readonly [string, string]> = [...ALWAYS];
  let noExtDiff = false;
  let includes = false;
  const handled = new Set<string>();
  for (const entry of entries) {
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
  ])
    mark(path);
  return parts.join("\n");
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
