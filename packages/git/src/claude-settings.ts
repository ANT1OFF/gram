import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { readInside, realRoot, writeInside } from "./contained.ts";
import { isUntrustedWorktree } from "./worktree-trust.ts";

export interface Buckets {
  readonly allow: ReadonlyArray<string>;
  readonly deny: ReadonlyArray<string>;
  readonly ask: ReadonlyArray<string>;
}

const BUCKET_KEYS = ["allow", "deny", "ask"] as const;

export const emptyBuckets: Buckets = { allow: [], deny: [], ask: [] };

/** Commands that must re-prompt per worktree: pushing, and touching a PR or release. */
export const EXCLUDED_PREFIXES: ReadonlyArray<string> = [
  "git push",
  "gh pr create",
  "gh pr merge",
  "gh pr review",
  "gh pr comment",
  "gh release",
];

/** The command inside `Tool(command)`, whitespace-collapsed and lowercased. No parens: the whole rule. */
export const ruleCommand = (rule: string): string => {
  const open = rule.indexOf("(");
  const close = rule.lastIndexOf(")");
  const inner = open >= 0 && close > open + 1 ? rule.slice(open + 1, close) : rule;
  return inner
    .split(/\s+/)
    .filter((part) => part !== "")
    .join(" ")
    .toLowerCase();
};

/** An outward-facing rule, matched at a command boundary: `git push:*` yes, `git pushx` no. */
export const isExcluded = (rule: string): boolean => {
  const command = ruleCommand(rule);
  return EXCLUDED_PREFIXES.some(
    (prefix) =>
      command === prefix ||
      (command.startsWith(prefix) && /^[^\p{L}\p{N}]/u.test(command.slice(prefix.length))),
  );
};

const SETTINGS_REL = ".claude/settings.local.json";

export const settingsPath = (dir: string): string =>
  nodePath.join(dir, ".claude", "settings.local.json");

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readSettings = (dir: string): JsonObject | undefined => {
  try {
    const parsed: unknown = JSON.parse(readInside(realRoot(dir), SETTINGS_REL));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const extract = (settings: JsonObject): Buckets => {
  const permissions = isObject(settings["permissions"]) ? settings["permissions"] : {};
  const list = (key: string) => {
    const value = permissions[key];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  };
  return { allow: list("allow"), deny: list("deny"), ask: list("ask") };
};

export const readPermissionRules = (dir: string): Buckets => {
  const settings = readSettings(dir);
  return settings ? extract(settings) : emptyBuckets;
};

const mapBuckets = (
  buckets: Buckets,
  f: (list: ReadonlyArray<string>) => Array<string>,
): Buckets => ({
  allow: f(buckets.allow),
  deny: f(buckets.deny),
  ask: f(buckets.ask),
});

const isEmpty = (buckets: Buckets): boolean =>
  BUCKET_KEYS.every((key) => buckets[key].length === 0);

/** Rules in `worktree` but not `root`, minus excluded ones: the removal checklist, allow → deny → ask. */
export const newRules = (worktree: Buckets, root: Buckets): Array<string> =>
  BUCKET_KEYS.flatMap((key) =>
    worktree[key].filter((rule) => !isExcluded(rule) && !root[key].includes(rule)),
  );

/** `buckets` without the rules in `tracked`, bucket by bucket. */
export const withoutRules = (buckets: Buckets, tracked: Buckets): Buckets => ({
  allow: buckets.allow.filter((rule) => !tracked.allow.includes(rule)),
  deny: buckets.deny.filter((rule) => !tracked.deny.includes(rule)),
  ask: buckets.ask.filter((rule) => !tracked.ask.includes(rule)),
});

/**
 * The rules of the settings file as the checkout's `HEAD` tracks it: rules a branch's author wrote,
 * not ones the user approved. Empty when the file isn't tracked or doesn't parse.
 */
export const parseTrackedRules = (content: string): Buckets => {
  try {
    const parsed: unknown = JSON.parse(content);
    return isObject(parsed) ? extract(parsed) : emptyBuckets;
  } catch {
    return emptyBuckets;
  }
};

/** Where the settings file is, relative to its checkout, as `git show HEAD:<path>` takes it. */
export const SETTINGS_TRACKED_PATH = SETTINGS_REL;

/**
 * Add-only union of `incoming` into `base.permissions`: existing entries first (non-string entries
 * kept), new ones appended, duplicates collapsed, other keys untouched, excluded rules dropped.
 * Doesn't materialise an empty list that wasn't there.
 */
export const unionInto = (base: unknown, incoming: Buckets): JsonObject => {
  const root: JsonObject = isObject(base) ? { ...base } : {};
  const permissions: JsonObject = isObject(root["permissions"]) ? { ...root["permissions"] } : {};
  for (const key of BUCKET_KEYS) {
    const add = incoming[key].filter((rule) => !isExcluded(rule));
    if (add.length === 0 && !(key in permissions)) continue;
    const existing = permissions[key];
    const list: Array<unknown> = Array.isArray(existing) ? existing.slice() : [];
    const seen = new Set(list.filter((v): v is string => typeof v === "string"));
    for (const rule of add) {
      if (!seen.has(rule)) {
        seen.add(rule);
        list.push(rule);
      }
    }
    permissions[key] = list;
  }
  root["permissions"] = permissions;
  return root;
};

const writeSettings = (dir: string, value: JsonObject): void => {
  writeInside(realRoot(dir), SETTINGS_REL, (fd) =>
    fs.writeFileSync(fd, JSON.stringify(value, null, 2)),
  );
};

const settingsLock = Semaphore.makeUnsafe(1);

const locked = <A>(f: () => A): Effect.Effect<A> =>
  Semaphore.withPermits(settingsLock, 1)(Effect.sync(f));

/**
 * Seed a new worktree with the repo root's rules (excluded ones dropped), unioning into an existing
 * worktree file without clobbering it. A no-op without a root file, and for an untrusted worktree
 * (`isUntrustedWorktree`), whose code the user's pre-approved commands mustn't cover. Never fails
 * creation.
 */
export const seedWorktreePermissions = (
  repoTop: string,
  worktreeDir: string,
): Effect.Effect<void> =>
  locked(() => {
    if (isUntrustedWorktree(worktreeDir)) return;
    const root = readSettings(repoTop);
    if (!root) return;
    const incoming = mapBuckets(extract(root), (list) => list.filter((rule) => !isExcluded(rule)));
    if (isEmpty(incoming)) return;
    writeSettings(worktreeDir, unionInto(readSettings(worktreeDir) ?? {}, incoming));
  }).pipe(Effect.catchDefect(() => Effect.void));

/**
 * Union the user-selected subset of a removed worktree's rules into the root file. Only rules present
 * in `worktree` count (their bucket is authoritative), and excluded rules never land.
 */
export const mergeSelectedIntoRoot = (
  repoTop: string,
  worktree: Buckets,
  selected: ReadonlyArray<string>,
): Effect.Effect<void> =>
  locked(() => {
    const incoming = mapBuckets(worktree, (list) =>
      list.filter((rule) => selected.includes(rule) && !isExcluded(rule)),
    );
    if (isEmpty(incoming)) return;
    writeSettings(repoTop, unionInto(readSettings(repoTop) ?? {}, incoming));
  }).pipe(Effect.catchDefect(() => Effect.void));
