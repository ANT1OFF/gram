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
 * value git treats as "nothing to run" where one exists, else the stock program. `undefined` for
 * any other key.
 */
export const neutralValue = (key: string, value: string | undefined): string | undefined => {
  const k = key.toLowerCase();
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
  if (k === "credential.helper" || /^credential\..+\.helper$/.test(k)) return "";
  if (/^filter\..+\.(?:clean|smudge|process)$/.test(k)) return "";
  if (/^filter\..+\.required$/.test(k)) return "false";
  if (/^diff\..+\.textconv$/.test(k)) return "cat";
  if (/^merge\..+\.driver$/.test(k)) return "false";
  if (/^remote\..+\.uploadpack$/.test(k)) return "git-upload-pack";
  if (/^remote\..+\.receivepack$/.test(k)) return "git-receive-pack";
  if (/^trailer\..+\.(?:cmd|command)$/.test(k)) return "true";
  if (/^(?:difftool|mergetool)\..+\.cmd$/.test(k)) return "false";
  if (/^lfs\.customtransfer\..+\.path$/.test(k)) return "false";
  if (k === "lfs.standalonetransferagent") return "";
  if (/^lfs\.extension\..+\.(?:clean|smudge)$/.test(k)) return "cat";
  if (/^submodule\..+\.update$/.test(k))
    return value !== undefined && value.startsWith("!") ? "checkout" : undefined;
  return undefined;
};

const OWN_TLS = /^http\.(?:.+\.)?(?:sslcainfo|sslcapath|sslcert|sslkey|pinnedpubkey)$/;

const httpKey = (key: string): { readonly url?: string; readonly name: string } | undefined => {
  const match = /^http\.(?:(.+)\.)?([^.]+)$/.exec(key);
  if (match === null) return undefined;
  return match[1] === undefined ? { name: match[2]! } : { url: match[1], name: match[2]! };
};

const urlSpecificity = (configUrl: string | undefined, url: string): number | undefined => {
  if (configUrl === undefined) return 0;
  const prefix = configUrl.replace(/\/+$/, "");
  return url === prefix || (url.startsWith(prefix) && url[prefix.length] === "/")
    ? prefix.length + 1
    : undefined;
};

const userHttpValues = (
  guard: Guard,
  url: string,
  name: string,
): ReadonlyArray<{ readonly value: string; readonly specificity: number }> =>
  (guard.userHttp ?? []).flatMap((entry) => {
    const key = httpKey(entry.key);
    if (key === undefined || key.name !== name) return [];
    const specificity = urlSpecificity(key.url, url);
    return specificity === undefined ? [] : [{ value: entry.value ?? "true", specificity }];
  });

const userHttpValue = (guard: Guard, url: string, name: string): string | undefined => {
  let best: { readonly value: string; readonly specificity: number } | undefined;
  for (const own of userHttpValues(guard, url, name))
    if (best === undefined || own.specificity >= best.specificity) best = own;
  return best?.value;
};

const envProxy = (env: Readonly<Record<string, string>>, url: string): string => {
  const names = url.startsWith("https://")
    ? ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]
    : ["http_proxy", "all_proxy", "ALL_PROXY"];
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  return "";
};

/**
 * `GIT_CONFIG_*` pairs for a git given `url` in place of a remote's name: how it reaches that URL
 * over HTTP, set for that exact URL, which no key a repository writes, before or after Gram reads
 * its config, can be more specific than, and which wins a tie by coming last. Each is the user's own
 * value (their config, then their environment's proxy) or git's default. Nothing for a URL git
 * doesn't reach over HTTP.
 */
export const pinnedTransport = (
  guard: Guard,
  url: string,
  env: Readonly<Record<string, string>>,
): ReadonlyArray<readonly [string, string]> => {
  if (!/^https?:\/\//i.test(url)) return [];
  const proxy = userHttpValue(guard, url, "proxy") ?? envProxy(env, url);
  const pairs: Array<readonly [string, string]> = [
    [`http.${url}.proxy`, proxy],
    [`remote.${url}.proxy`, proxy],
    [`http.${url}.sslVerify`, userHttpValue(guard, url, "sslverify") ?? "true"],
    [`http.${url}.cookieFile`, userHttpValue(guard, url, "cookiefile") ?? ""],
    [`http.${url}.followRedirects`, userHttpValue(guard, url, "followredirects") ?? "initial"],
  ];
  for (const name of ["extraHeader", "curloptResolve"]) {
    pairs.push([`http.${url}.${name}`, ""]);
    for (const own of userHttpValues(guard, url, name.toLowerCase()))
      pairs.push([`http.${url}.${name}`, own.value]);
  }
  return pairs;
};

const isExternalDiff = (key: string): boolean => {
  const k = key.toLowerCase();
  return k === "diff.external" || /^diff\..+\.command$/.test(k);
};

const isInclude = (key: string): boolean => {
  const k = key.toLowerCase();
  return k === "include.path" || /^includeif\..+\.path$/.test(k);
};

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
  /**
   * What the repository's own `url.*.insteadOf` and `url.*.pushInsteadOf` rewrite, and the names
   * of the remotes it configures: a URL git is given that starts with one of the first, or is one
   * of the second, goes where the repository says rather than where it reads.
   */
  readonly redirects?: {
    readonly prefixes: ReadonlyArray<string>;
    readonly remotes: ReadonlyArray<string>;
  };
  /**
   * The repository names its own TLS trust or client certificate (`http.sslCAInfo`, `sslCAPath`,
   * `sslCert`, `sslKey`, `pinnedPubkey`), which no value can neutralise: an empty one breaks TLS.
   */
  readonly ownTls?: boolean;
  /** The user's own `http.*` entries (system, global, command), for `pinnedTransport`. */
  readonly userHttp?: ReadonlyArray<ConfigEntry>;
}

/** Whether git given `url` would go elsewhere by the repository's own config (`Guard.redirects`). */
export const redirectedBy = (guard: Guard, url: string): boolean =>
  guard.redirects !== undefined &&
  (guard.redirects.remotes.includes(url) ||
    guard.redirects.prefixes.some((prefix) => url.startsWith(prefix)));

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
  const prefixes: Array<string> = [];
  const remotes: Array<string> = [];
  let ownTls = false;
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
    if (OWN_TLS.test(entry.key.toLowerCase())) ownTls = true;
    if (/^url\..+\.(?:insteadof|pushinsteadof)$/.test(entry.key) && entry.value !== undefined)
      prefixes.push(entry.value);
    const remote = /^remote\.(.+)\.[^.]+$/.exec(entry.key)?.[1];
    if (remote !== undefined) remotes.push(remote);
    if (isExternalDiff(entry.key)) noExtDiff = true;
    const neutral = neutralValue(entry.key, entry.value);
    if (neutral === undefined || handled.has(entry.key)) continue;
    handled.add(entry.key);
    pairs.push([entry.key, neutral]);
    for (const own of entries) {
      if (own.key === entry.key && !REPO_SCOPES.has(own.scope))
        pairs.push([own.key, own.value ?? "true"]);
    }
  }
  const userHttp = entries.filter(
    (entry) => !REPO_SCOPES.has(entry.scope) && entry.key.toLowerCase().startsWith("http."),
  );
  return { pairs, noExtDiff, includes, redirects: { prefixes, remotes }, ownTls, userHttp };
};

/** `env` with `pairs` as the next `GIT_CONFIG_*` entries after any already set. */
export const appendGitConfig = (
  env: Readonly<Record<string, string>>,
  pairs: ReadonlyArray<readonly [string, string]>,
): Readonly<Record<string, string>> => {
  if (pairs.length === 0) return env;
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
  const insertAt = sub === "stash" ? (args[at + 1] === "show" ? at + 2 : -1) : at + 1;
  if (insertAt < 0) return args;
  return [...args.slice(0, insertAt), "--no-ext-diff", ...args.slice(insertAt)];
};

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

/**
 * The common dir a nested repository's git folder shares, as its `commondir` file names it
 * (relative to the folder), whose `config` git reads for it too. `undefined` when it has none.
 */
export const nestedCommonDir = (gitDir: string): string | undefined => {
  let text: string;
  try {
    text = fs.readFileSync(nodePath.join(gitDir, "commondir"), "utf8");
  } catch {
    return undefined;
  }
  const named = text.replace(/\r?\n$/, "");
  return named === "" ? undefined : nodePath.resolve(gitDir, named);
};

/** A submodule git folder's config files, in the order git reads them. */
export const submoduleConfigFiles = (gitDir: string): ReadonlyArray<string> => [
  nodePath.join(gitDir, "config"),
  nodePath.join(gitDir, "config.worktree"),
];

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
  const markFollowed = (path: string) => {
    mark(path);
    const target = statOrUndefined(path);
    parts.push(
      target === undefined
        ? `${path}=>-`
        : target.isDirectory()
          ? `${path}=>d${target.ino}`
          : `${path}=>${target.ino}:${target.ctimeNs}:${target.size}`,
    );
  };
  const markConfigOf = (dir: string) => {
    markFollowed(nodePath.join(dir, "commondir"));
    const shared = nestedCommonDir(dir);
    for (const path of [
      ...submoduleConfigFiles(dir),
      ...(shared === undefined ? [] : submoduleConfigFiles(shared)),
    ])
      markFollowed(path);
  };
  let dir = nodePath.resolve(cwd);
  for (;;) {
    markFollowed(nodePath.join(dir, ".git"));
    markFollowed(nodePath.join(dir, "HEAD"));
    const parent = nodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const path of [
    nodePath.join(gitDir, "commondir"),
    nodePath.join(gitDir, "config.worktree"),
    nodePath.join(commonDir, "config"),
    nodePath.join(commonDir, "config.worktree"),
    nodePath.join(gitDir, "index"),
  ])
    markFollowed(path);
  for (const nested of nestedGitDirs) {
    mark(nested);
    mark(nodePath.join(nested, "index"));
    markConfigOf(nested);
  }
  for (const path of gitlinkDotGits) markFollowed(path);
  const submodules = submoduleGitDirs(commonDir);
  if (submodules === undefined) parts.push("submodules:too-many");
  else for (const sub of submodules) markConfigOf(sub);
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
