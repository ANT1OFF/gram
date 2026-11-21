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
import { isForeignPath, Proc } from "@gram/git";
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
import { folderExists, ghFolderOf } from "../fs/folders.ts";
import { redactText } from "../logging/redact.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { SqlClient, type SqlError } from "../platform/unstable.ts";
import { BranchHeads } from "../wakes/branch-heads.ts";
import { WorkerHosts } from "../host/worker-host.ts";
import { AutoMerges } from "./auto-merges.ts";
import { GitStatePublisher } from "./publisher.ts";
import { makeKeyedLock } from "./keyed-lock.ts";
import { projectRepo } from "./repo-reach.ts";
import { withMachines, workerOwnsPr } from "./worker-pr.ts";

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
  /** A person approved holding every workspace's merges, not only the caller's workspace's. */
  readonly acrossWorkspaces?: boolean | undefined;
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
   * The freeze that holds back a merge of PR `number` by a thread of `workspaceId` onto the repo's
   * branch (any branch of the repo when it isn't known), or `undefined`: a freeze standing there
   * that doesn't allow it, set in that workspace or, with a person's yes, across workspaces.
   */
  readonly holding: (
    repo: string,
    branch: string | undefined,
    number: number | undefined,
    workspaceId: string | undefined,
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

const binderOf = (threads: ReadonlyArray<Thread>, repo: string, number: number) =>
  threads.find(
    (thread) =>
      thread.boundPr !== undefined &&
      sameRepo(thread.boundPr.repo, repo) &&
      thread.boundPr.number === number,
  );

const shortHead = (head: string | undefined) => head?.slice(0, 7) ?? "an unknown commit";

const StoredFreeze = Schema.Struct({
  ...MergeFreeze.fields,
  cwd: Schema.optionalKey(Schema.String),
});
type StoredFreeze = typeof StoredFreeze.Type;

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(StoredFreeze));
const encode = (freeze: StoredFreeze) => JSON.stringify(Schema.encodeSync(StoredFreeze)(freeze));

const publicOf = (stored: StoredFreeze): MergeFreeze => {
  const { cwd, ...freeze } = stored;
  return cwd === undefined ? stored : freeze;
};

const run = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.catch((error) => Effect.die(error)));

const oneLine = (text: string) =>
  Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  })
    .join("")
    .replaceAll(/\s+/g, " ")
    .trim();

const EXPIRY_LOOK_MS = 60_000;

const refuse = (message: string) => new AppToolError({ tool: "merge_freeze", message });

const minuteText = (at: number) => `${new Date(at).toISOString().slice(11, 16)}Z`;

const standing = <F extends MergeFreeze>(freeze: F | undefined, now: number) =>
  freeze !== undefined && freeze.until > now ? freeze : undefined;

const folderOf = (thread: Thread) => ghFolderOf(thread.checkout);

export const MergeFreezesLive = Layer.effect(
  MergeFreezes,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ThreadStore;
    const hub = yield* EventHub;
    const heads = yield* BranchHeads;
    const autoMerges = yield* AutoMerges;
    const runtimes = yield* ThreadRuntimes;
    const publisher = yield* GitStatePublisher;
    const proc = yield* Proc;
    const machines = Option.getOrUndefined(yield* Effect.serviceOption(WorkerHosts));
    const changed = yield* PubSub.unbounded<FreezeChange>();
    const freezes = new Map<string, StoredFreeze>();
    const expiries = yield* FiberMap.make<string>();
    const fences = makeKeyedLock<string>();
    const locks = makeKeyedLock<string>();

    const write = (key: string, freeze: StoredFreeze) =>
      Effect.gen(function* () {
        const data = encode(freeze);
        yield* run(
          sql`INSERT INTO merge_freezes (key, data) VALUES (${key}, ${data})
            ON CONFLICT(key) DO UPDATE SET data = excluded.data`,
        );
        freezes.set(key, freeze);
      });

    const ghFolder = (freeze: StoredFreeze) =>
      Effect.gen(function* () {
        if (
          freeze.cwd !== undefined &&
          !isForeignPath(freeze.cwd) &&
          (yield* folderExists(freeze.cwd))
        )
          return freeze.cwd;
        return tmpdir();
      });

    const rearmOwner = (repo: string, number: number) =>
      Effect.gen(function* () {
        const owner = binderOf(yield* store.listThreads, repo, number);
        if (owner === undefined || owner.parked || owner.babysit !== undefined) return undefined;
        if (owner.boundPr?.mergeWhenReady?.hold !== undefined) return undefined;
        if (owner.workspaceId === undefined) return owner;
        const state = yield* store
          .getWorkspace(owner.workspaceId)
          .pipe(Effect.orElseSucceed(() => undefined));
        return state?.paused === undefined ? owner : undefined;
      });

    const tellNotRearmed = (owner: Thread, ended: StoredFreeze, number: number, why: string) =>
      runtimes
        .sendNotice(owner.id, `merge-freeze:${ended.repo}#${number}`, {
          text: `The merge freeze on ${ended.repo} ${ended.branch} ended, and Gram left the GitHub auto-merge it turned off on ${ended.repo}#${number} off: ${why}. Gram arms an auto-merge again only on the head it stood on. If the PR's head now is one to merge, arm its auto-merge again (set_auto_merge) or ask the user to.`,
        })
        .pipe(
          Effect.catch((e) =>
            Effect.logWarning("merge freeze notice not sent").pipe(
              Effect.annotateLogs({ threadId: owner.id, error: e.message }),
            ),
          ),
        );

    const handOff = (key: string, entries: NonNullable<StoredFreeze["disarmed"]>) =>
      locks.withLock(
        key,
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const next = standing(freezes.get(key), now);
          if (next === undefined) return false;
          const kept = next.disarmed ?? [];
          yield* write(key, {
            ...next,
            disarmed: [...kept, ...entries.filter((d) => !kept.some((k) => k.number === d.number))],
          });
          return true;
        }),
      );

    const rearm = (key: string, ended: StoredFreeze) =>
      Effect.gen(function* () {
        const disarmed = ended.disarmed ?? [];
        if (disarmed.length === 0) return;
        if (yield* handOff(key, disarmed)) return;
        const cwd = yield* ghFolder(ended);
        const rearmOne = (entry: NonNullable<StoredFreeze["disarmed"]>[number]) =>
          Effect.gen(function* () {
            const { number, method, head } = entry;
            if (yield* handOff(key, [entry])) return;
            const owner = yield* rearmOwner(ended.repo, number);
            if (owner === undefined) return;
            if (head === undefined) {
              return yield* tellNotRearmed(
                owner,
                ended,
                number,
                "the freeze didn't record which head it was armed on",
              );
            }
            const now = yield* autoMerges.headOf(cwd, ended.repo, number);
            if (now?.open === false) return;
            if (now !== undefined && now.head !== head) {
              return yield* tellNotRearmed(
                owner,
                ended,
                number,
                `its head moved from ${shortHead(head)}, the head it was armed on, to ${shortHead(now.head)} while the freeze stood`,
              );
            }
            const failed = yield* autoMerges.enable(cwd, ended.repo, number, method, head);
            if (failed === undefined) return;
            yield* Effect.logWarning("merge freeze couldn't re-arm an auto-merge").pipe(
              Effect.annotateLogs({ repo: ended.repo, number, error: failed }),
            );
            const armedNow = yield* autoMerges.armed(cwd, ended.repo, ended.branch);
            if (armedNow?.some((pr) => pr.number === number && pr.head === head) === true) return;
            yield* tellNotRearmed(
              owner,
              ended,
              number,
              `GitHub refused to arm it on ${shortHead(head)}: ${failed.split("\n")[0]!.slice(0, 200)}`,
            );
          });
        for (const entry of disarmed) {
          yield* fences.withLock(ended.repo.toLowerCase(), rearmOne(entry));
        }
      });

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

    const holding: MergeFreezesShape["holding"] = (repo, branch, number, workspaceId) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const found = [...freezes.values()].find(
          (freeze) =>
            sameRepo(freeze.repo, repo) &&
            (branch === undefined || freeze.branch === branch) &&
            standing(freeze, now) !== undefined &&
            mergeFreezeHolds(freeze, number, workspaceId),
        );
        return found === undefined ? undefined : publicOf(found);
      });

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
          const origin = projectRepo(project);
          if (origin !== undefined && sameRepo(origin, repo)) return true;
        }
        return false;
      });

    const gramOwns = (set: StoredFreeze, number: number) =>
      Effect.gen(function* () {
        const repo = set.repo;
        let claimed = false;
        for (const thread of yield* store.listThreads) {
          const bound = thread.boundPr;
          if (bound === undefined || !sameRepo(bound.repo, repo) || bound.number !== number)
            continue;
          if (!mergeFreezeHolds(set, undefined, thread.workspaceId)) continue;
          const owns = yield* workerOwnsPr(thread, repo, number).pipe(
            Effect.provideService(ThreadStore, store),
            Effect.provideService(Proc, proc),
            withMachines(machines),
            Effect.catchCause(() => Effect.succeed(false)),
          );
          if (owns) return "owned" as const;
          claimed = true;
        }
        return claimed ? ("bound" as const) : ("none" as const);
      });

    const disarm = (key: string, set: StoredFreeze) =>
      Effect.gen(function* () {
        const cwd = yield* ghFolder(set);
        const armed = yield* autoMerges.armed(cwd, set.repo, set.branch);
        if (armed === undefined) {
          return [
            `GitHub's auto-merges onto ${set.branch} couldn't be listed, so any armed on Gram's PRs are still armed`,
          ];
        }
        const failed: Array<string> = [];
        for (const pr of armed) {
          if ((set.allow ?? []).includes(pr.number)) continue;
          const whose = yield* gramOwns(set, pr.number);
          if (whose === "bound")
            failed.push(`#${pr.number}: a thread binds it, but it isn't a Gram worker's own`);
          if (whose !== "owned") continue;
          const outcome = yield* locks.withLock(
            key,
            Effect.gen(function* () {
              const current = freezes.get(key);
              if (current === undefined) return "ended" as const;
              if ((current.disarmed ?? []).some((d) => d.number === pr.number)) {
                return "kept" as const;
              }
              const taken = {
                number: pr.number,
                method: pr.method,
                ...(pr.head === undefined ? {} : { head: pr.head }),
              };
              yield* write(key, { ...current, disarmed: [...(current.disarmed ?? []), taken] });
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
                ...(input.acrossWorkspaces === true || held?.acrossWorkspaces === true
                  ? { acrossWorkspaces: true as const }
                  : {}),
                reason: oneLine(redactText(input.reason)).slice(0, MERGE_FREEZE_REASON_MAX),
                ...(allow === undefined || allow.length === 0
                  ? {}
                  : { allow: [...new Set(allow)] }),
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
        const notDisarmed = yield* disarm(key, set);
        return { freeze: publicOf(freezes.get(key) ?? set), notDisarmed };
      });

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
