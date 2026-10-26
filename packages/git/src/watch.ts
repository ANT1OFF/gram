// Filesystem watches behind push-based git state: the repo's common `.git` dir (commits, checkouts,
// staging, fetches — linked worktrees' git dirs live under it) plus each checkout's working tree (edits
// made outside the agent). Events are classified to the affected checkouts, coalesced in a debounce
// window, throttled per checkout, and recomputed; only a changed state is published.

import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { GitState } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { tryRepoRoots, type RepoRoots } from "./exec.ts";
import { localGitState } from "./git-state.ts";
import { tryRealPathSync } from "./paths.ts";
import type { Proc } from "./proc.ts";

/**
 * High-churn build/dependency dirs dropped from the working-tree pass, matched as whole components
 * BELOW the toplevel, so a repo under an ancestor named `build` still reports edits. `.worktrees` is
 * absent on purpose: a worktree's own toplevel lives under it.
 */
export const PRUNE_DIRS: ReadonlyArray<string> = [
  "node_modules",
  "target",
  "build",
  "dist",
  "__pycache__",
  ".venv",
  "venv",
  ".mypy_cache",
  ".pytest_cache",
  "obj",
  ".gradle",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
];

export const DEBOUNCE_MS = 400;
/** Floor on recomputes from working-tree churn per checkout; leading and trailing edge both run. */
export const COOLDOWN_MS = 2_000;

/** Settles once every native watcher call so far has. */
let nativeTail: Promise<unknown> = Promise.resolve();

/**
 * Runs `task` once every native watcher call started before it has settled, so subscribes and
 * unsubscribes never overlap anywhere in the process: on Windows @parcel/watcher can crash the process
 * (0xC0000005) when subscriptions are released concurrently, whichever watches release them.
 */
export const serialized = <A>(task: () => Promise<A>): Promise<A> => {
  const run = nativeTail.then(task);
  nativeTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

/**
 * Which watcher backs a root. Windows and macOS use libuv's `fs.watch`: on Windows @parcel/watcher
 * frees a subscription on unsubscribe while its pending directory read can still complete, crashing
 * the process with 0xC0000005 (parcel-bundler/watcher#262), and on macOS both sit on FSEvents, so the
 * packaged app ships no watcher addon. Linux keeps @parcel/watcher, loaded on first use: Node's
 * recursive `fs.watch` there walks the tree and spends an inotify watch on every directory, ignored
 * ones included.
 */
export type WatchBackend = "parcel" | "node";

export const defaultBackend = (platform: NodeJS.Platform = process.platform): WatchBackend =>
  platform === "linux" ? "parcel" : "node";

/** Paths below a watched root whose events are dropped. */
export interface RootIgnore {
  /** Matched against the first path component only. */
  readonly topLevel: ReadonlyArray<string>;
  /** Matched against every path component. */
  readonly anyDepth: ReadonlyArray<string>;
}

export const parcelIgnore = (ignore: RootIgnore): Array<string> => [
  ...ignore.topLevel,
  ...ignore.anyDepth.map((d) => `**/${d}`),
];

/** Whether `relative`, a path below the root with either separator, falls under `ignore`. */
export const isIgnored = (relative: string, ignore: RootIgnore): boolean => {
  const components = relative.split(/[\\/]/).filter((c) => c !== "");
  const [first] = components;
  if (first !== undefined && ignore.topLevel.includes(first)) return true;
  return components.some((c) => ignore.anyDepth.includes(c));
};

/** Receives absolute event paths, or `undefined` when events were lost. */
export type RootListener = (paths: ReadonlyArray<string> | undefined) => void;

/** How long after an FSEvents restart live `fs.watch` listeners are told events may be lost. */
export const FSEVENTS_RESTART_SETTLE_MS = 100;

const nodeListeners = new Set<RootListener>();
const restartNudged = new Set<RootListener>();
let restartNudge: ReturnType<typeof setTimeout> | undefined;

/**
 * On macOS libuv runs every `fs.watch` through one FSEvents stream and restarts it whenever a watch
 * starts or closes, dropping events that land within tens of milliseconds. Once that window has
 * passed, every live listener is told events were lost, coalesced across a burst of restarts.
 */
const nudgeAfterRestart = () => {
  if (process.platform !== "darwin") return;
  for (const listener of nodeListeners) restartNudged.add(listener);
  if (restartNudge !== undefined || restartNudged.size === 0) return;
  restartNudge = setTimeout(() => {
    restartNudge = undefined;
    const due = [...restartNudged];
    restartNudged.clear();
    for (const listener of due) if (nodeListeners.has(listener)) listener(undefined);
  }, FSEVENTS_RESTART_SETTLE_MS);
  restartNudge.unref();
};

/** Watches `dir` recursively; resolves to the watch's release. */
export const subscribeRoot = async (
  backend: WatchBackend,
  dir: string,
  ignore: RootIgnore,
  listener: RootListener,
): Promise<() => Promise<void>> => {
  if (backend === "node") {
    const watcher = fs.watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
      if (filename === null) listener(undefined);
      else if (!isIgnored(filename, ignore)) listener([nodePath.join(dir, filename)]);
    });
    watcher.on("error", () => listener(undefined));
    nodeListeners.add(listener);
    nudgeAfterRestart();
    return () => {
      watcher.close();
      nodeListeners.delete(listener);
      nudgeAfterRestart();
      return Promise.resolve();
    };
  }
  const { default: ParcelWatcher } = await import("@parcel/watcher");
  const subscription = await serialized(() =>
    ParcelWatcher.subscribe(
      dir,
      (err, events) => listener(err ? undefined : events.map((event) => event.path)),
      {
        ignore: parcelIgnore(ignore),
        // Parcel's default probes watchman with popen; a missing binary throws while decoding BSER
        // before pclose, leaking an unreaped shell (seen in 0.10.0-rc.5). Linux needs only inotify.
        ...(process.platform === "linux" ? { backend: "inotify" as const } : {}),
      },
    ),
  );
  return () => serialized(() => subscription.unsubscribe());
};

export interface WatchedCheckout extends RepoRoots {
  /** The path the caller asked to watch; the key of every published change. */
  readonly path: string;
}

export interface Classification {
  /** Checkouts to recompute. */
  readonly hit: Set<string>;
  /** The subset whose event was git-internal (prompt, never throttled). */
  readonly internal: Set<string>;
}

const normalise = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");

const relativeUnder = (path: string, root: string): string | undefined => {
  const p = normalise(path);
  const r = normalise(root);
  if (p === r) return "";
  // oxlint-disable-next-line gram/no-raw-path -- both spelled as the watcher reports them, `/` only
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : undefined;
};

/**
 * Entries at the top of the common dir that belong to the main checkout alone, as a linked
 * worktree's own copies live in its `worktrees/<name>` dir. A `.lock` beside one counts as it.
 */
const MAIN_CHECKOUT_ONLY: ReadonlySet<string> = new Set([
  "HEAD",
  "index",
  "AUTO_MERGE",
  "COMMIT_EDITMSG",
  "MERGE_MSG",
  "MERGE_MODE",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
]);

/**
 * Which of the checkouts sharing `common` an event at `rel` below it can change: its own git dir's
 * for `worktrees/<name>/…` and the main checkout's private files, none for Gram's checkpoint
 * refs, which no git state reads, and all of them for anything else (refs, packed-refs, config).
 * Every checkout used to recompute on any of these, so one worktree's `git status` refreshing its
 * index, or one turn's checkpoint, recomputed every worktree of the repo.
 */
const commonDirTargets = (
  rel: string,
  common: string,
  sharing: ReadonlyArray<WatchedCheckout>,
): ReadonlyArray<WatchedCheckout> => {
  const components = rel.split("/");
  const [first = "", second] = components;
  const refs = first === "logs" ? components.slice(1) : components;
  if (refs[0] === "refs" && refs[1] === "gram" && refs[2] === "checkpoints") return [];
  if (first === "worktrees") {
    if (second === undefined) return [];
    const own = `${normalise(common)}/worktrees/${second}`;
    return sharing.filter((c) => normalise(c.gitDir) === own);
  }
  const entry = first.replace(/\.lock$/, "");
  const mainOnly =
    MAIN_CHECKOUT_ONLY.has(entry) ||
    (components.length === 1 && entry.endsWith("_HEAD")) ||
    rel === "logs/HEAD";
  return mainOnly ? sharing.filter((c) => normalise(c.gitDir) === normalise(common)) : sharing;
};

const classifyOnce = (
  path: string,
  checkouts: ReadonlyArray<WatchedCheckout>,
  out: Classification,
): boolean => {
  for (const checkout of checkouts) {
    const rel = relativeUnder(path, checkout.common);
    if (rel === undefined) continue;
    const sharing = checkouts.filter((c) => normalise(c.common) === normalise(checkout.common));
    for (const target of commonDirTargets(rel, checkout.common, sharing)) {
      out.hit.add(target.path);
      out.internal.add(target.path);
    }
    return true;
  }
  // Longest toplevel wins, so an edit inside an enclosed `.worktrees/<name>` goes to that worktree
  // rather than the main checkout recursively enclosing it. Ties (one checkout, many threads) all hit.
  let best: { length: number; rel: string; paths: Array<string> } | undefined;
  for (const checkout of checkouts) {
    const rel = relativeUnder(path, checkout.top);
    if (rel === undefined) continue;
    const length = normalise(checkout.top).length;
    if (!best || length > best.length) best = { length, rel, paths: [checkout.path] };
    else if (length === best.length) best.paths.push(checkout.path);
  }
  if (!best) return false;
  for (const component of best.rel.split("/")) {
    // A `.git` suffix belongs to the common-dir pass; leave it unclaimed for the canonical retry.
    if (component === ".git") return false;
    if (PRUNE_DIRS.includes(component)) return true;
  }
  for (const p of best.paths) out.hit.add(p);
  return true;
};

/**
 * Route one event path. The raw path is tried first (no syscall); only a path matching no root is
 * canonicalised, bridging macOS `/var`↔`/private/var` and Windows 8.3 names.
 */
export const classifyPath = (
  path: string,
  checkouts: ReadonlyArray<WatchedCheckout>,
  out: Classification,
  canonicalize: (path: string) => string | undefined = tryRealPathSync,
): void => {
  if (classifyOnce(path, checkouts, out)) return;
  const canonical = canonicalize(path);
  if (canonical !== undefined && canonical !== path) classifyOnce(canonical, checkouts, out);
};

/** How long a throttled recompute must wait: 0 outside the cooldown window. */
export const cooldownDelay = (
  lastRun: number | undefined,
  now: number,
  cooldownMs: number,
): number =>
  lastRun === undefined || now - lastRun >= cooldownMs ? 0 : cooldownMs - (now - lastRun);

export interface GitStateChange {
  readonly path: string;
  readonly state: GitState;
}

export interface WatchOptions {
  readonly debounceMs?: number | undefined;
  readonly cooldownMs?: number | undefined;
  /** Defaults to {@link defaultBackend} for this platform. */
  readonly backend?: WatchBackend | undefined;
}

const sameState = (a: GitState | undefined, b: GitState) =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b);

/**
 * A stream of local git state for `paths`: each path's initial state, then a new state whenever a
 * watched event changes it. A recompute that times out keeps the last published state. Watches are
 * released when the stream ends.
 */
export const watchGitState = (
  paths: ReadonlyArray<string>,
  options: WatchOptions = {},
): Stream.Stream<GitStateChange, never, Proc> =>
  Stream.callback<GitStateChange, never, Proc>((queue) =>
    Effect.gen(function* () {
      const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
      const cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
      const runFork = yield* FiberMap.makeRuntime<Proc, string>();
      const last = new Map<string, GitState>();
      const lastThrottledRun = new Map<string, number>();

      const recompute = (path: string) =>
        localGitState(path).pipe(
          Effect.map((state) => {
            if (sameState(last.get(path), state)) return;
            last.set(path, state);
            Queue.offerUnsafe(queue, { path, state });
          }),
          Effect.ignore,
        );

      const schedule = (path: string, prompt: boolean) => {
        if (prompt) {
          runFork(path, recompute(path));
          return;
        }
        const delay = cooldownDelay(lastThrottledRun.get(path), Date.now(), cooldownMs);
        if (delay === 0) {
          lastThrottledRun.set(path, Date.now());
          runFork(path, recompute(path));
        } else {
          runFork(
            path,
            Effect.sleep(delay).pipe(
              Effect.andThen(Effect.sync(() => lastThrottledRun.set(path, Date.now()))),
              Effect.andThen(recompute(path)),
            ),
            { onlyIfMissing: true },
          );
        }
      };

      const checkouts: Array<WatchedCheckout> = [];
      for (const path of paths) {
        const roots = yield* tryRepoRoots(path).pipe(Effect.orElseSucceed(() => undefined));
        if (roots) checkouts.push({ path, ...roots });
      }

      const pending = new Map<string, boolean>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        timer = undefined;
        for (const [path, prompt] of pending) schedule(path, prompt);
        pending.clear();
      };
      const enqueue = (classification: Classification) => {
        for (const path of classification.hit) {
          pending.set(path, (pending.get(path) ?? false) || classification.internal.has(path));
        }
        if (pending.size > 0 && timer === undefined) timer = setTimeout(flush, debounceMs);
      };
      const onEvents: RootListener = (eventPaths) => {
        const classification: Classification = { hit: new Set(), internal: new Set() };
        if (eventPaths === undefined) {
          // Events were lost; per-path attribution is meaningless, so recompute everything.
          for (const checkout of checkouts) {
            classification.hit.add(checkout.path);
            classification.internal.add(checkout.path);
          }
        } else {
          for (const path of eventPaths) classifyPath(path, checkouts, classification);
        }
        enqueue(classification);
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (timer !== undefined) clearTimeout(timer);
        }),
      );

      const backend = options.backend ?? defaultBackend();
      const roots = new Map<string, RootIgnore>();
      for (const checkout of checkouts) {
        roots.set(checkout.common, { topLevel: ["objects", "lfs"], anyDepth: [] });
        if (!roots.has(checkout.top))
          roots.set(checkout.top, { topLevel: [".git"], anyDepth: PRUNE_DIRS });
      }
      for (const [dir, ignore] of roots) {
        // A root that can't be watched (OS limit, permissions) degrades to no live updates for it.
        yield* Effect.option(
          Effect.acquireRelease(
            Effect.tryPromise(() => subscribeRoot(backend, dir, ignore, onEvents)),
            (release) => Effect.promise(release).pipe(Effect.ignore),
          ),
        );
      }
      // Publish only once subscribed, so a write right after the first emission is never missed.
      for (const path of paths) yield* recompute(path);
    }),
  );
