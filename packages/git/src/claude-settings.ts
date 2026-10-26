// Sync the repo-root `.claude/settings.local.json` permission lists into worktrees: Claude Code treats
// each worktree as its own project root, and the file is gitignored, so `git worktree add` leaves every
// worktree thread re-approving everything. Seeds on create; unions a user-picked checklist back on
// remove. Add-only, and outward-facing commands are never carried in either direction. The file is
// read and written only inside its own checkout: a branch can track `.claude` as a link elsewhere.

import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { readInside, realRoot, writeInside } from "./contained.ts";

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

/**
 * The parsed settings object; `undefined` when missing, unreadable, non-JSON, not an object, or
 * reached through a link.
 */
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
    const list: Array<unknown> = Array.isArray(existing) ? [...existing] : [];
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

/** Throws when the file or its `.claude` folder is a link or resolves outside `dir`. */
const writeSettings = (dir: string, value: JsonObject): void => {
  writeInside(realRoot(dir), SETTINGS_REL, (fd) =>
    fs.writeFileSync(fd, JSON.stringify(value, null, 2)),
  );
};

/**
 * Serialises every read → union → write of a settings file, so two worktrees removed concurrently
 * can't lost-update the same root file. Coarse and process-wide; contention is negligible.
 */
const settingsLock = Semaphore.makeUnsafe(1);

const locked = <A>(f: () => A): Effect.Effect<A> =>
  Semaphore.withPermits(settingsLock, 1)(Effect.sync(f));

/**
 * Seed a new worktree with the repo root's rules (excluded ones dropped), unioning into an existing
 * worktree file without clobbering it. A no-op without a root file. Never fails creation.
 */
export const seedWorktreePermissions = (
  repoTop: string,
  worktreeDir: string,
): Effect.Effect<void> =>
  locked(() => {
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
