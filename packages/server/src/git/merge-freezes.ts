/**
 * Merge freezes (`merge_freeze`): a thread holds Gram's own merges to a repo's branch, such as main
 * while a release is cut, with a reason and an expiry of at most `MERGE_FREEZE_MAX_MINUTES`. While
 * one stands, `merge_when_ready` waits instead of merging, saying who froze the branch and why, and
 * `set_auto_merge` refuses, except for the PRs the freeze allows (the release PR it is for). The
 * repo must be one of the caller's workspace's.
 *
 * GitHub merges a PR whose auto-merge is armed by itself, under any freeze of Gram's. So a freeze
 * turns off the auto-merge that its repo's PRs onto the branch had armed, where the PR is one of
 * Gram's threads', keeps them on the freeze, and arms them again with the same method once it ends
 * (handing them to a freeze that stands on the branch by then instead). A PR someone turns off,
 * holds, unbinds or closes meanwhile is let go of (`forget`), never armed again. A person's merge, an
 * auto-merge on a PR no Gram thread has, or an entry already in a merge queue, it can't stop.
 *
 * A freeze always ends at its `until`. That is checked on every read, whatever the timers did, so
 * a freeze whose thread died, or whose expiry fell while the app was down, never outlives it. A
 * closed thread's freezes end with it. Only the thread that froze a branch may renew it; that
 * thread or its workspace's orchestrator may lift it. Each end is told on `changes`, which the merge
 * gate and the `freezeLifted` wakes listen to.
 */
import {
  AppToolError,
  MERGE_FREEZE_ALLOW_MAX,
  MERGE_FREEZE_MAX_MINUTES,
  MERGE_FREEZE_REASON_MAX,
  MERGE_FREEZE_TOTAL_MAX_MINUTES,
  BranchName,
  MergeFreeze,
  mergeFreezeHolds,
  mergeFreezeText,
  repoFromPrUrl,
  type PrStatus,
  type Thread,
} from "@gram/contracts";
import { tmpdir } from "node:os";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { EventHub, isThreadRemoved } from "../events/event-hub.ts";
import { folderExists } from "../fs/folders.ts";
import { redactText } from "../logging/redact.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient, type SqlError } from "../platform/unstable.ts";
import { BranchHeads } from "../wakes/branch-heads.ts";
import { AutoMerges } from "./auto-merges.ts";
import { GitStatePublisher } from "./publisher.ts";
import { makeKeyedLock } from "./keyed-lock.ts";

/** What `merge_freeze` asks for. */
export interface FreezeInput {
  readonly repo: string;
  /** Without one, the repo's default branch. */
  readonly branch?: string | undefined;
  readonly reason: string;
  /** At most `MERGE_FREEZE_MAX_MINUTES`, which is also the default. */
  readonly minutes?: number | undefined;
  /** PR numbers in the repo that may still merge; a renewal without it keeps the ones it had. */
  readonly allow?: ReadonlyArray<number> | undefined;
}

/** What a freeze did: the freeze, and the GitHub auto-merges it couldn't turn off, with why. */
export interface FreezeSet {
  readonly freeze: MergeFreeze;
  readonly notDisarmed: ReadonlyArray<string>;
}

/** A repo's branch whose freeze changed: set, renewed, lifted or expired. */
export interface FreezeChange {
  readonly repo: string;
  readonly branch: string;
}

export interface MergeFreezesShape {
  /** Freezes, or renews the caller's own freeze of, a branch of a repo of the caller's workspace. */
  readonly freeze: (caller: Thread, input: FreezeInput) => Effect.Effect<FreezeSet, AppToolError>;
  /** Lifts a freeze: the caller's own, or one of a thread in the workspace it orchestrates. */
  readonly lift: (
    caller: Thread,
    input: { readonly repo: string; readonly branch?: string | undefined },
  ) => Effect.Effect<MergeFreeze, AppToolError>;
  /** The freeze standing on the repo's branch now; with no branch known, any standing on the repo. */
  readonly active: (
    repo: string,
    branch: string | undefined,
  ) => Effect.Effect<MergeFreeze | undefined>;
  /**
   * The freeze that holds back a merge of PR `number` onto the repo's branch (any branch of the
   * repo when it isn't known), or `undefined`: a freeze standing there that doesn't allow it.
   */
  readonly holding: (
    repo: string,
    branch: string | undefined,
    number: number | undefined,
  ) => Effect.Effect<MergeFreeze | undefined>;
  /** Every freeze standing now. */
  readonly list: Effect.Effect<ReadonlyArray<MergeFreeze>>;
  /**
   * Drops PR `number` from what any freeze of `repo` arms again when it ends: someone turned its
   * auto-merge off, held or unbound it, or it closed or merged. Kept at once, so a restart doesn't
   * bring it back.
   */
  readonly forget: (repo: string, number: number) => Effect.Effect<void>;
  /**
   * Runs a merge's last check and its launch with no freeze of the repo landing between them: a
   * freeze set meanwhile waits for the launch, and one set before it is seen by the check.
   */
  readonly fence: <A, E, R>(repo: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly changes: Stream.Stream<FreezeChange>;
}

export class MergeFreezes extends Context.Service<MergeFreezes, MergeFreezesShape>()(
  "@gram/server/MergeFreezes",
) {}

const keyOf = (repo: string, branch: string) => `${repo.toLowerCase()}#${branch}`;
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A freeze as stored: with the folder gh runs in when it ends, the freezing thread's or none. */
const StoredFreeze = Schema.Struct({
  ...MergeFreeze.fields,
  cwd: Schema.optionalKey(Schema.String),
});
type StoredFreeze = typeof StoredFreeze.Type;

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(StoredFreeze));
const encode = (freeze: StoredFreeze) => JSON.stringify(Schema.encodeSync(StoredFreeze)(freeze));

/** The freeze as the tools and the gate see it, without the stored folder. */
const publicOf = (stored: StoredFreeze): MergeFreeze => {
  const { cwd, ...freeze } = stored;
  return cwd === undefined ? stored : freeze;
};

const run = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.catch((error) => Effect.die(error)));

/** `text` on one line: control characters and runs of whitespace as single spaces. */
const oneLine = (text: string) =>
  Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  })
    .join("")
    .replaceAll(/\s+/g, " ")
    .trim();

/** The longest a freeze's watcher sleeps before it reads the clock again. */
const EXPIRY_LOOK_MS = 60_000;

const refuse = (message: string) => new AppToolError({ tool: "merge_freeze", message });

/** `14:05Z`. */
const minuteText = (at: number) => `${new Date(at).toISOString().slice(11, 16)}Z`;

/** `freeze`, unless it has expired by `now`. */
const standing = <F extends MergeFreeze>(freeze: F | undefined, now: number) =>
  freeze !== undefined && freeze.until > now ? freeze : undefined;

/** A folder of the thread's to run gh in: its checkout, or its repo's main one. */
const folderOf = (thread: Thread) =>
  Effect.gen(function* () {
    const cwd = thread.checkout.path;
    return (yield* folderExists(cwd)) || thread.checkout.repoRoot === undefined
      ? cwd
      : thread.checkout.repoRoot;
  });

export const MergeFreezesLive = Layer.effect(
  MergeFreezes,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ThreadStore;
    const hub = yield* EventHub;
    const heads = yield* BranchHeads;
    const autoMerges = yield* AutoMerges;
    const publisher = yield* GitStatePublisher;
    const changed = yield* PubSub.unbounded<FreezeChange>();
    /** Per repo and branch, the freeze stored, expired or not; reads skip an expired one. */
    const freezes = new Map<string, StoredFreeze>();
    /** Per repo and branch, the timer that ends its freeze at `until`. */
    const expiries = yield* FiberMap.make<string>();
    /** Per repo, lower-cased: freezes and merge launches, one at a time. */
    const fences = makeKeyedLock<string>();
    /** Per repo and branch: a freeze's read and write. */
    const locks = makeKeyedLock<string>();

    /** Stores `freeze`, then keeps it in memory: one that can't be stored stands nowhere. */
    const write = (key: string, freeze: StoredFreeze) =>
      Effect.gen(function* () {
        const data = encode(freeze);
        yield* run(
          sql`INSERT INTO merge_freezes (key, data) VALUES (${key}, ${data})
            ON CONFLICT(key) DO UPDATE SET data = excluded.data`,
        );
        freezes.set(key, freeze);
      });

    /** A folder to run gh in for a freeze's repo: the one it kept, while it is there. */
    const ghFolder = (freeze: StoredFreeze) =>
      Effect.gen(function* () {
        if (freeze.cwd !== undefined && (yield* folderExists(freeze.cwd))) return freeze.cwd;
        return tmpdir();
      });

    /**
     * Whether a PR whose auto-merge a freeze took down may have it armed again now: a Gram thread
     * still binds it, that thread isn't archived or babysat or in a paused workspace, and no hold
     * stands on its merge. A PR let go of on purpose (`forget`) isn't asked about at all.
     */
    const mayRearm = (repo: string, number: number) =>
      Effect.gen(function* () {
        const owner = (yield* store.listThreads).find((thread) =>
          [thread.boundPr, ...(thread.extraPrs ?? [])].some(
            (pr) => pr !== undefined && sameRepo(pr.repo, repo) && pr.number === number,
          ),
        );
        if (owner === undefined || owner.parked || owner.babysit !== undefined) return false;
        if (
          owner.boundPr !== undefined &&
          owner.boundPr.number === number &&
          sameRepo(owner.boundPr.repo, repo) &&
          owner.boundPr.mergeWhenReady?.hold !== undefined
        )
          return false;
        if (owner.workspaceId === undefined) return true;
        const state = yield* store
          .getWorkspace(owner.workspaceId)
          .pipe(Effect.orElseSucceed(() => undefined));
        return state?.paused === undefined;
      });

    /**
     * Arms again the GitHub auto-merges an ended freeze turned off, or hands them to the freeze that
     * stands on the branch by then, which arms them when it ends.
     */
    const rearm = (key: string, ended: StoredFreeze) =>
      Effect.gen(function* () {
        const disarmed = ended.disarmed ?? [];
        if (disarmed.length === 0) return;
        const handed = yield* locks.withLock(
          key,
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const next = standing(freezes.get(key), now);
            if (next === undefined) return false;
            const kept = next.disarmed ?? [];
            yield* write(key, {
              ...next,
              disarmed: [
                ...kept,
                ...disarmed.filter((d) => !kept.some((k) => k.number === d.number)),
              ],
            });
            return true;
          }),
        );
        if (handed) return;
        const cwd = yield* ghFolder(ended);
        for (const { number, method } of disarmed) {
          // Asked again now: what became of the PR meanwhile decides, not what it was.
          if (!(yield* mayRearm(ended.repo, number))) continue;
          const failed = yield* autoMerges.enable(cwd, ended.repo, number, method);
          // A PR merged or closed meanwhile has nothing to arm; anything else is logged.
          if (failed !== undefined) {
            yield* Effect.logWarning("merge freeze couldn't re-arm an auto-merge").pipe(
              Effect.annotateLogs({ repo: ended.repo, number, error: failed }),
            );
          }
        }
      });

    /**
     * Ends the freeze `key` holds, if it is still `expected` (or any, without one). Not cut short
     * once begun: its end is always told and what it took down always armed again.
     */
    const end = (key: string, expected?: MergeFreeze) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const ended = yield* locks.withLock(
            key,
            Effect.gen(function* () {
              const current = freezes.get(key);
              if (current === undefined) return undefined;
              if (expected !== undefined && current.until !== expected.until) return undefined;
              freezes.delete(key);
              yield* run(sql`DELETE FROM merge_freezes WHERE key = ${key}`);
              return current;
            }),
          );
          if (ended === undefined) return undefined;
          yield* PubSub.publish(changed, { repo: ended.repo, branch: ended.branch });
          yield* rearm(key, ended);
          return publicOf(ended);
        }),
      );

    /**
     * Watches the freeze `key` holds until it is gone, ending it once its `until` has passed. It reads
     * the freeze and the clock again at least every `EXPIRY_LOOK_MS`, so a renewal, a lift or a
     * timer that slept through the Mac sleeping never leaves a freeze ending late. One per key: a new
     * freeze replaces it.
     */
    const arm = (key: string) =>
      FiberMap.run(
        expiries,
        key,
        Effect.gen(function* () {
          while (true) {
            const current = freezes.get(key);
            if (current === undefined) return;
            const now = yield* Clock.currentTimeMillis;
            if (current.until <= now) {
              yield* end(key, current);
              continue;
            }
            yield* Effect.sleep(Duration.millis(Math.min(current.until - now, EXPIRY_LOOK_MS)));
          }
        }),
      );

    // What a previous run left: one that expired meanwhile is gone at once.
    for (const row of yield* run(
      sql<{ key: string; data: string }>`SELECT key, data FROM merge_freezes`,
    )) {
      const freeze = decode(row.data);
      if (Option.isNone(freeze)) {
        yield* run(sql`DELETE FROM merge_freezes WHERE key = ${row.key}`);
        continue;
      }
      freezes.set(row.key, freeze.value);
      yield* arm(row.key);
    }

    const forget: MergeFreezesShape["forget"] = (repo, number) =>
      Effect.forEach(
        [...freezes].filter(
          ([, freeze]) =>
            sameRepo(freeze.repo, repo) && (freeze.disarmed ?? []).some((d) => d.number === number),
        ),
        ([key]) =>
          locks.withLock(
            key,
            Effect.gen(function* () {
              const current = freezes.get(key);
              if (current === undefined) return;
              const kept = (current.disarmed ?? []).filter((d) => d.number !== number);
              if (kept.length === (current.disarmed ?? []).length) return;
              const { disarmed: _, ...rest } = current;
              yield* write(key, kept.length === 0 ? rest : { ...rest, disarmed: kept });
            }),
          ),
        { discard: true },
      );

    /** A PR Gram sees closed or merged is never armed again. */
    const onBadge = (badge: PrStatus | undefined) =>
      Effect.gen(function* () {
        if (badge === undefined || badge.state === "OPEN" || badge.stale !== undefined) return;
        const repo = repoFromPrUrl(badge.url);
        if (repo !== undefined) yield* forget(repo, badge.number);
      });
    yield* publisher.observe({
      onState: (_thread, state) =>
        freezes.size === 0
          ? Effect.void
          : Effect.forEach([state.pr, ...(state.extraPrs ?? [])], onBadge, { discard: true }),
      onRound: () => Effect.void,
      onWatchedPr: (badge) => (freezes.size === 0 ? Effect.void : onBadge(badge)),
    });

    // A closed thread's freezes end with it; an archived one's run out on their own.
    yield* hub.internalEvents(isThreadRemoved, "merge freezes").pipe(
      Stream.runForEach(({ threadId }) =>
        Effect.forEach(
          [...freezes].filter(([, freeze]) => freeze.threadId === threadId),
          ([key, freeze]) => end(key, freeze),
          { discard: true },
        ),
      ),
      Effect.forkScoped,
    );

    const active: MergeFreezesShape["active"] = (repo, branch) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const found =
          branch !== undefined
            ? standing(freezes.get(keyOf(repo, branch)), now)
            : [...freezes.values()].find(
                (freeze) => sameRepo(freeze.repo, repo) && standing(freeze, now) !== undefined,
              );
        return found === undefined ? undefined : publicOf(found);
      });

    const holding: MergeFreezesShape["holding"] = (repo, branch, number) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const found = [...freezes.values()].find(
          (freeze) =>
            sameRepo(freeze.repo, repo) &&
            (branch === undefined || freeze.branch === branch) &&
            standing(freeze, now) !== undefined &&
            mergeFreezeHolds(freeze, number),
        );
        return found === undefined ? undefined : publicOf(found);
      });

    /** Whether `repo` is the origin of one of the projects of `caller`'s workspace. */
    const inWorkspace = (caller: Thread, repo: string) =>
      Effect.gen(function* () {
        if (caller.workspaceId === undefined) return false;
        const state = yield* store
          .getWorkspace(caller.workspaceId)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (state === undefined) return false;
        const ids = new Set<string>(state.workspace.projectIds);
        for (const project of yield* store.listProjects) {
          if (!ids.has(project.id)) continue;
          if (!(yield* folderExists(project.root))) continue;
          const origin = yield* autoMerges.repoOf(project.root);
          if (origin !== undefined && sameRepo(origin, repo)) return true;
        }
        return false;
      });

    /** The PRs of Gram's threads in `repo`, whose GitHub auto-merge a freeze takes down. */
    const gramPrs = (repo: string) =>
      store.listThreads.pipe(
        Effect.map(
          (threads) =>
            new Set(
              threads.flatMap((thread) =>
                [thread.boundPr, ...(thread.extraPrs ?? [])].flatMap((pr) =>
                  pr !== undefined && sameRepo(pr.repo, repo) ? [pr.number] : [],
                ),
              ),
            ),
        ),
      );

    /**
     * Turns off GitHub's auto-merge on the PRs of Gram's threads onto the frozen branch, the allowed
     * ones aside, and keeps them on the freeze; answers those it couldn't, with why.
     */
    const disarm = (key: string, set: StoredFreeze) =>
      Effect.gen(function* () {
        const cwd = yield* ghFolder(set);
        const armed = yield* autoMerges.armed(cwd, set.repo, set.branch);
        if (armed === undefined) {
          return [
            `GitHub's auto-merges onto ${set.branch} couldn't be listed, so any armed on Gram's PRs are still armed`,
          ];
        }
        const ours = yield* gramPrs(set.repo);
        const failed: Array<string> = [];
        for (const pr of armed) {
          if (!ours.has(pr.number) || (set.allow ?? []).includes(pr.number)) continue;
          // On the freeze's record before GitHub is asked, under its lock: a quit partway leaves
          // at worst a PR recorded that wasn't turned off, which arming again does no harm to,
          // never one turned off that nothing arms again. Ended meanwhile: nothing more is taken.
          const outcome = yield* locks.withLock(
            key,
            Effect.gen(function* () {
              const current = freezes.get(key);
              if (current === undefined) return "ended" as const;
              if ((current.disarmed ?? []).some((d) => d.number === pr.number)) {
                return "kept" as const;
              }
              yield* write(key, { ...current, disarmed: [...(current.disarmed ?? []), pr] });
              const why = yield* autoMerges.disable(cwd, set.repo, pr.number);
              if (why === undefined) return "taken" as const;
              const now = freezes.get(key);
              if (now !== undefined) {
                const kept = (now.disarmed ?? []).filter((d) => d.number !== pr.number);
                const { disarmed: _, ...rest } = now;
                yield* write(key, kept.length === 0 ? rest : { ...rest, disarmed: kept });
              }
              return why;
            }),
          );
          if (outcome === "ended") break;
          if (outcome !== "kept" && outcome !== "taken") {
            failed.push(`#${pr.number}: ${outcome.split("\n")[0]!.slice(0, 200)}`);
          }
        }
        return failed;
      });

    /** The freeze `input` names: its branch, else the one standing on the repo. */
    const named = (input: { readonly repo: string; readonly branch?: string | undefined }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (input.branch !== undefined) {
          const key = keyOf(input.repo, input.branch);
          const freeze = standing(freezes.get(key), now);
          return freeze === undefined ? undefined : { key, freeze };
        }
        const found = [...freezes].find(
          ([, held]) => sameRepo(held.repo, input.repo) && standing(held, now) !== undefined,
        );
        return found === undefined ? undefined : { key: found[0], freeze: found[1] };
      });

    const freeze: MergeFreezesShape["freeze"] = (caller, input) =>
      Effect.gen(function* () {
        const minutes = input.minutes ?? MERGE_FREEZE_MAX_MINUTES;
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MERGE_FREEZE_MAX_MINUTES) {
          return yield* refuse(
            `A freeze lasts at most ${MERGE_FREEZE_MAX_MINUTES} minutes; renew it before it runs out.`,
          );
        }
        if ((input.allow?.length ?? 0) > MERGE_FREEZE_ALLOW_MAX) {
          return yield* refuse(`A freeze allows at most ${MERGE_FREEZE_ALLOW_MAX} PRs.`);
        }
        if (!(yield* inWorkspace(caller, input.repo))) {
          return yield* refuse(
            `${input.repo} isn't the repo of any of your workspace's projects; a freeze is only for those.`,
          );
        }
        const cwd = yield* folderOf(caller);
        const branch = input.branch ?? (yield* heads.defaultBranch(cwd, input.repo));
        if (branch !== undefined && !Schema.is(BranchName)(branch)) {
          return yield* refuse(`"${branch}" isn't a branch name a freeze can hold.`);
        }
        if (branch === undefined) {
          return yield* refuse(
            `GitHub couldn't say what ${input.repo}'s default branch is; name the \`branch\`.`,
          );
        }
        const key = keyOf(input.repo, branch);
        const set = yield* fences.withLock(
          input.repo.toLowerCase(),
          locks.withLock(
            key,
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const held = standing(freezes.get(key), now);
              if (held !== undefined && held.threadId !== caller.id) {
                return yield* refuse(
                  `${mergeFreezeText(held)}. Wait for it with schedule_wake's freezeLifted condition.`,
                );
              }
              const allow = input.allow ?? held?.allow;
              const since = held?.since ?? held?.at ?? now;
              const cap = since + MERGE_FREEZE_TOTAL_MAX_MINUTES * 60_000;
              if (cap - now < 60_000) {
                return yield* refuse(
                  `This freeze has stood ${MERGE_FREEZE_TOTAL_MAX_MINUTES / 60} hours, the most one may; it ends at ${minuteText(held?.until ?? now)}, and the merges it held go then.`,
                );
              }
              const next: StoredFreeze = {
                repo: input.repo,
                branch,
                threadId: caller.id,
                title: caller.title,
                ...(caller.workspaceId === undefined ? {} : { workspaceId: caller.workspaceId }),
                // One line: it is shown inline in other threads' refusals and the ledger.
                reason: oneLine(redactText(input.reason)).slice(0, MERGE_FREEZE_REASON_MAX),
                ...(allow === undefined || allow.length === 0
                  ? {}
                  : { allow: [...new Set(allow)] }),
                // A renewal keeps what the freeze took down, to arm again when it ends.
                ...(held?.disarmed === undefined ? {} : { disarmed: held.disarmed }),
                at: now,
                since,
                until: Math.min(now + minutes * 60_000, cap),
                cwd,
              };
              yield* write(key, next);
              return next;
            }),
          ),
        );
        yield* arm(key);
        yield* PubSub.publish(changed, { repo: set.repo, branch: set.branch });
        // After the freeze stands, so Gram arms nothing new meanwhile; a renewal takes down any
        // armed since.
        const notDisarmed = yield* disarm(key, set);
        return { freeze: publicOf(freezes.get(key) ?? set), notDisarmed };
      });

    /** Whether `caller` orchestrates the workspace the freeze's thread was in. */
    const orchestrates = (caller: Thread, held: MergeFreeze) =>
      Effect.gen(function* () {
        if (held.workspaceId === undefined) return false;
        const state = yield* store
          .getWorkspace(held.workspaceId)
          .pipe(Effect.orElseSucceed(() => undefined));
        return state?.workspace.orchestratorThreadId === caller.id;
      });

    const lift: MergeFreezesShape["lift"] = (caller, input) =>
      Effect.gen(function* () {
        const found = yield* named(input);
        if (found === undefined) {
          return yield* refuse(
            `${input.repo}${input.branch === undefined ? "" : ` ${input.branch}`} isn't frozen.`,
          );
        }
        const { key, freeze: held } = found;
        if (held.threadId !== caller.id && !(yield* orchestrates(caller, held))) {
          return yield* refuse(
            `Only "${held.title}" or its orchestrator can lift this freeze; it expires at ${minuteText(held.until)}.`,
          );
        }
        // Its watcher stops by itself, finding the freeze gone.
        const ended = yield* end(key, held);
        return ended ?? held;
      });

    return MergeFreezes.of({
      freeze,
      lift,
      active,
      holding,
      forget,
      list: Effect.map(Clock.currentTimeMillis, (now) =>
        [...freezes.values()].filter((each) => standing(each, now) !== undefined).map(publicOf),
      ),
      fence: (repo, effect) => fences.withLock(repo.toLowerCase(), effect),
      changes: Stream.fromPubSub(changed),
    });
  }),
);

/** No freezes at all, for a test of something else that builds the merge gate. */
export const MergeFreezesNone = Layer.succeed(MergeFreezes, {
  freeze: () => Effect.fail(refuse("Merge freezes aren't available here.")),
  lift: () => Effect.fail(refuse("Merge freezes aren't available here.")),
  active: () => Effect.succeed(undefined),
  holding: () => Effect.succeed(undefined),
  forget: () => Effect.void,
  list: Effect.succeed([]),
  fence: (_repo, effect) => effect,
  changes: Stream.empty,
});
