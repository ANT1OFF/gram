// Stopping a check of Gram's own once its result can no longer count: its pull request merged,
// closed or moved past the checked head, its merge intent was dropped, its thread asked, or a check
// of the same head on its base's newer tip took its place. Its fiber is interrupted, which stops
// its process group and removes its worktree as any interruption does (`spawnCommand`), and it ends
// failed, `cancelled` saying why. Only this machine's checks: a joined machine's runs on its host.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import { existsSync } from "node:fs";
import * as nodePath from "node:path";

import {
  recordedGroup,
  RETAINED,
  stopVerifiedGroup,
  type LocalCheckOutcome,
} from "./check-process.ts";
import { makeKeyedLock } from "./keyed-lock.ts";
import type { LocalCheck } from "./local-checks.ts";

/** The pull request a check was run for. */
export interface CheckPr {
  readonly repo: string;
  readonly number: number;
}

/** Whether `check` was run for `pr`. */
export const isCheckOf = (check: LocalCheck, pr: CheckPr): boolean =>
  check.pr !== undefined &&
  check.pr.number === pr.number &&
  check.pr.repo.toLowerCase() === pr.repo.toLowerCase();

interface CheckCancelDeps {
  readonly records: ReadonlyMap<string, LocalCheck>;
  /** Puts `check` in memory as how `key` reads now. */
  readonly remember: (key: string, check: LocalCheck) => void;
  readonly fibers: FiberMap.FiberMap<number>;
  readonly removeWork: (own: string, dir: string) => Effect.Effect<void>;
  readonly finish: (key: string, check: LocalCheck) => Effect.Effect<void>;
  readonly endedAs: (
    running: LocalCheck,
    result: LocalCheckOutcome,
    finishedAt: number,
  ) => LocalCheck;
}

export const makeCheckCancel = (deps: CheckCancelDeps) => {
  let runs = 0;
  /** The fiber running each check's key, while it runs. */
  const fiberOf = new Map<string, number>();
  const cancelling = new Set<string>();
  /** Per Gram repository and head: deciding to start, join or replace a check is one at a time. */
  const heads = makeKeyedLock<string>();

  /** Runs `effect` in its own fiber; with `key`, as that check's, which `cancelKey` can stop. */
  const fork = <A, E>(key: string | undefined, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      const id = ++runs;
      if (key === undefined) return FiberMap.run(deps.fibers, id, effect);
      fiberOf.set(key, id);
      return FiberMap.run(
        deps.fibers,
        id,
        effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (fiberOf.get(key) === id) fiberOf.delete(key);
            }),
          ),
        ),
      );
    });

  /**
   * Cancels the running check `key`, saying `why`, once its processes are stopped: how it then
   * reads, or undefined when it wasn't running here or ended first.
   */
  const cancelKey = (key: string, why: string): Effect.Effect<LocalCheck | undefined> => {
    let mine = false;
    return Effect.gen(function* () {
      // Read and interrupted in one step: a check that ended meanwhile has told its listeners.
      const running = yield* Effect.suspend(() => {
        const found = deps.records.get(key);
        if (found?.status !== "running" || found.machine !== undefined || cancelling.has(key))
          return Effect.succeed(undefined);
        cancelling.add(key);
        mine = true;
        const id = fiberOf.get(key);
        return (id === undefined ? Effect.void : FiberMap.remove(deps.fibers, id)).pipe(
          Effect.as(found),
        );
      });
      if (running === undefined) return undefined;
      const now = deps.records.get(key) ?? running;
      if (now.status !== "running") return undefined;
      const job = now.job;
      // What a live check's interruption couldn't show gone is kept (`markRetained`); a check taken
      // back after a quit is followed only, so its group is stopped here.
      let keep =
        job?.work !== undefined && existsSync(nodePath.join(nodePath.dirname(job.work), RETAINED));
      if (job?.pid !== undefined && job.processStart !== undefined && job.work !== undefined) {
        const recorded = { pid: job.pid, processStart: job.processStart, work: job.work };
        const state = yield* Effect.sync(() => recordedGroup(recorded, false));
        if (state === "ours")
          keep = !(yield* Effect.promise(() => stopVerifiedGroup(job.pid!))) || keep;
        else if (state !== "gone") keep = true;
      }
      if (job?.work !== undefined && !keep) yield* deps.removeWork(job.own, job.work);
      const ended: LocalCheck = {
        ...deps.endedAs(
          now,
          { ok: false, reason: `cancelled: ${why}`, failure: { kind: "stopped" } },
          yield* Clock.currentTimeMillis,
        ),
        cancelled: why,
      };
      // It reads as ended at once; it is saved and its listeners told in a fiber of their own, since
      // a listener may ask for a check of the same head, whose decision may be waiting on this one.
      yield* Effect.sync(() => deps.remember(key, ended));
      yield* fork(undefined, deps.finish(key, ended));
      return ended;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (mine) cancelling.delete(key);
        }),
      ),
    );
  };

  /** Cancels every running check of `pr` here that `keep` doesn't keep: those it cancelled. */
  const cancel = (pr: CheckPr, why: string, keep?: (check: LocalCheck) => boolean) =>
    Effect.forEach(
      [...deps.records].filter(
        ([, check]) => check.status === "running" && isCheckOf(check, pr) && keep?.(check) !== true,
      ),
      ([key]) => cancelKey(key, why),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((ended) => ended.filter((check) => check !== undefined)));

  /**
   * Before a check of `head` on `base` starts in Gram's repository `own`: a running one of the same
   * head and run on an older base, which `base` descends from, is cancelled, since a pass on a base
   * that moved on counts for nothing; one on any other base is returned, to join rather than run a
   * second beside it.
   */
  const makeWay = (
    own: string,
    head: string,
    base: string,
    sameRun: (check: LocalCheck) => boolean,
    descends: (older: string) => Effect.Effect<boolean>,
  ) =>
    Effect.gen(function* () {
      for (const [key, other] of deps.records) {
        if (
          other.status !== "running" ||
          other.machine !== undefined ||
          other.job?.own !== own ||
          other.head !== head ||
          other.base === base ||
          !sameRun(other)
        )
          continue;
        if (!(yield* descends(other.base))) return { key, check: other };
        yield* cancelKey(
          key,
          `its base moved on to ${base.slice(0, 7)}, which a new check runs on`,
        );
      }
      return undefined;
    });

  /** Runs `effect`, the decision to start a check of `head` in `own`, after any other's. */
  const deciding = <A, E, R>(own: string, head: string, effect: Effect.Effect<A, E, R>) =>
    heads.withLock(`${own}\u0000${head}`, effect);

  return { fork, cancel, makeWay, deciding };
};
