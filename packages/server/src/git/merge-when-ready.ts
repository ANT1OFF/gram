import {
  agentOwnsPrEvents,
  AppToolError,
  currentBaseOf,
  isLocalHost,
  samePr,
  mergePolicyReady,
  mergeReviewPolicyOf,
  reviewBotsOf,
  autonomyOf,
  mergeAfterDependencies,
  localCheckOnHead,
  mergeFreezeText,
  type BoundPr,
  type LocalCheckPass,
  type ReviewBot,
  type GitState,
  type MergeIntent,
  type PrStatus,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import { gh, gitFailMsg, invalidatePrBadges, Pr, Proc } from "@gram/git";
import {
  userMergeApproverIsOrchestrator,
  userMergeAuthorizationMatches,
  userMergeDelegationIsLive,
} from "./user-merge-authorization.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Cause from "effect/Cause";
import { forThread } from "../embedding/gh-thread.ts";
import { EventHub } from "../events/event-hub.ts";
import { folderExists, ghFolderOf } from "../fs/folders.ts";
import { mergeDelegationStands } from "../orchestration/rules.ts";
import { Orchestration } from "../orchestration/service.ts";
import type { MergeFence, PendingMerge } from "../persistence/merge-fence.ts";
import { ThreadStore, type ThreadUpdateContext } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { isBadgeOf } from "./extra-prs.ts";
import { type CheckSite, checkSiteOf } from "./check-site.ts";
import { LocalChecks, type LocalCheck } from "./local-checks.ts";
import { makeCheckSettle } from "./merge-check-cancel.ts";
import { MergeFreezes } from "./merge-freezes.ts";
import { GitRefresh } from "./platform.ts";
import { GitStatePublisher } from "./publisher.ts";
import {
  explainOwnershipBlocker,
  OWNERSHIP_BLOCKERS,
  ownershipFix,
  ownedPrNoLongerStands,
  prHostOf,
  workerPrBlocker,
  workerPrIdentity,
  workerPrOwnership,
  withMachines,
} from "./worker-pr.ts";
import { WorkerHosts } from "../host/worker-host.ts";
import {
  localCheckCancelledText,
  localCheckFailedText,
  localCheckPassedText,
  prName,
} from "./check-texts.ts";
import { mergedText, refusedText, uncertaintyText, waitingText } from "./merge-texts.ts";
export { localCheckFailedText, prName } from "./check-texts.ts";
import { makeKeyedLock } from "./keyed-lock.ts";

const LAUNCH_TRIES = 3;

/**
 * How long a merge that has to wait (on `after`, a base GitHub hasn't moved on, a read that failed)
 * waits before it asks again.
 */
export const MergeRecheckMs = Context.Reference<number>("@gram/server/MergeRecheckMs", {
  defaultValue: () => Duration.toMillis(Duration.minutes(2)),
});

const RECHECKS_BEFORE_TELLING = 3;

const MOVED_BASES_KEPT = 32;

const baseKey = (repo: string, baseRef: string | undefined) =>
  `${repo.toLowerCase()}\u0000${baseRef ?? ""}`;

/** `owner/repo#N`, or a pull request's URL, as the PR it names. */
export const parsePrRef = (
  text: string,
): { readonly repo: string; readonly number: number } | undefined => {
  const trimmed = text.trim();
  const match =
    /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(trimmed) ??
    /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(trimmed);
  return match === null ? undefined : { repo: match[1]!, number: Number(match[2]) };
};

const ASK_AGAIN = "call merge_when_ready again, so the user approves what it would merge now";

/**
 * Why the user's approval of `intent` no longer covers the PR `badge` shows, or `undefined`. A user
 * approval covers the base its card named, and on a fork the exact head too: anyone who can push
 * to a fork can move its head, so a new head there merges or runs nothing until the user approves
 * it. A head in the repository itself moves only by those the repository lets push. An approval
 * recorded before Gram recorded what it covers asks again. `autonomy` intents recheck ownership at
 * launch instead.
 */
export const approvalBlocker = (intent: MergeIntent, badge: PrStatus): string | undefined => {
  if (intent.allowedBy !== "user") return undefined;
  const approved = intent.approved;
  if (approved === undefined)
    return `the user's approval doesn't say which head and base it covers; ${ASK_AGAIN}`;
  if (badge.baseRef === undefined) return "its base branch isn't known yet";
  if (badge.baseRef !== approved.baseRef)
    return `its base changed from ${approved.baseRef} to ${badge.baseRef} after the user approved it; ${ASK_AGAIN}`;
  if (approved.fork && badge.headRefOid !== approved.head)
    return `its head is on a fork${approved.headRepo === undefined ? "" : ` (${approved.headRepo})`} and moved from ${approved.head.slice(0, 7)}, the head the user approved, to ${badge.headRefOid?.slice(0, 7) ?? "an unknown commit"}; Gram neither checks nor merges a new fork head until the user approves it: ${ASK_AGAIN}`;
  return undefined;
};

/**
 * Why the PR `badge` shows isn't to be merged now, before `after` is asked about, or `undefined`
 * when it is ready. A badge that didn't read the reviews can't say the approval is on its head.
 */
export const mergeBlocker = (
  intent: MergeIntent,
  badge: PrStatus,
  policy: "solo" | "bot" = "bot",
  bots?: ReadonlyArray<ReviewBot>,
  localCheck?: LocalCheckPass,
  declaredCi?: boolean,
): string | undefined => {
  if (intent.hold !== undefined) return `held: ${intent.hold}`;
  if (badge.state !== "OPEN") return `it is ${badge.state.toLowerCase()}`;
  if (badge.headRefOid === undefined) return "its head isn't known yet";
  if (intent.failedOn === badge.headRefOid) return "a merge of this head was refused";
  const drift = approvalBlocker(intent, badge);
  if (drift !== undefined) return drift;
  if (badge.reviewUnread === true) return "its reviews weren't read";
  if (!mergePolicyReady(badge, policy, bots, localCheck, declaredCi))
    return policy === "bot"
      ? "not approved on its head, green and clean yet"
      : declaredCi === true
        ? "not fresh, its base's declared CI not passing on its head, or not allowed by GitHub yet"
        : localCheckOnHead(badge, localCheck)
          ? badge.mergeChecks === "pending"
            ? "locally checked, waiting on the CI jobs its merge policy always requires"
            : "locally checked, but not fresh, free of failing checks and allowed by GitHub yet"
          : "not fresh, green (or locally checked on its head) and allowed by GitHub yet";
  return undefined;
};

const PAUSED_BLOCKER = "the workspace is paused";

const featurePaused = (
  workspace: { readonly pausedFeatures?: ReadonlyArray<string> | undefined },
  thread: Pick<Thread, "spawnedBy">,
): boolean =>
  thread.spawnedBy !== undefined &&
  workspace.pausedFeatures?.includes(thread.spawnedBy.feature) === true;

const repoDirOf = (thread: Thread) =>
  Effect.gen(function* () {
    const cwd = thread.checkout.path;
    return (yield* folderExists(cwd)) || thread.checkout.repoRoot === undefined
      ? cwd
      : thread.checkout.repoRoot;
  });

const checkSiteFor = (thread: Thread, here: Effect.Effect<string>): Effect.Effect<CheckSite> =>
  isLocalHost(thread.checkout)
    ? here
    : Effect.succeed(checkSiteOf(thread.checkout, thread.checkout.path));

const ghDirOf = (thread: Thread) => ghFolderOf(thread.checkout);

const fenceRefusal = (message: string) =>
  new AppToolError({ tool: "resolve_merge_fence", message });

export interface MergeWhenReadyShape {
  /** Explicit, approved reconciliation only; Github terminal state is always read by Gram. */
  readonly resolveFence: (
    caller: ThreadId,
    input: {
      readonly repo: string;
      readonly number: number;
      readonly head: string;
      readonly at?: number;
      readonly userApproved: boolean;
    },
  ) => Effect.Effect<
    {
      readonly resolved: true;
      readonly terminal: string;
      readonly observedHead: string;
      readonly base: string;
    },
    AppToolError
  >;
  /**
   * Looks at `threadId`'s PR now, as a new state would, so an intent set on a ready PR merges it and
   * one waiting on `after` asks again at once.
   */
  readonly check: (threadId: ThreadId) => Effect.Effect<void>;
  /**
   * Runs `change` to a thread's intent with no merge of it between its last look and its launch:
   * the attempt under way is stopped first, and the PR is looked at again after.
   */
  readonly mutate: <A, E>(threadId: ThreadId, change: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  /**
   * Under solo, runs Gram's own full check of the thread's bound PR now: its head as GitHub has it,
   * merged onto its base's tip. A pass for that exact pair is reused, a failure is run again. The
   * thread is told how it ends, and an armed merge looks again on a pass. Never takes a commit from
   * the caller: what is checked is what GitHub would merge.
   */
  readonly runLocalCheck: (
    threadId: ThreadId,
    options?: {
      /** False only reports the check Gram has of the pair, starting none. */
      readonly start?: boolean | undefined;
      /** Cancels the PR's running checks instead, unless an armed merge would start them again. */
      readonly cancel?: boolean | undefined;
    },
  ) => Effect.Effect<LocalCheckStart>;
}

interface BaseTurn {
  readonly threadId: ThreadId;
  readonly pr: BoundPr;
  readonly listener: string;
  readonly queued: Set<ThreadId>;
}

type LocalCheckStart =
  | {
      readonly check: LocalCheck | undefined;
      readonly reused: boolean;
    }
  | { readonly refused: string }
  | { readonly cancelled: ReadonlyArray<LocalCheck> };

export class MergeWhenReady extends Context.Service<MergeWhenReady, MergeWhenReadyShape>()(
  "@gram/server/MergeWhenReady",
) {}

export const MergeWhenReadyLive = Layer.effect(
  MergeWhenReady,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    const publisher = yield* GitStatePublisher;
    const hub = yield* EventHub;
    const proc = yield* Proc;
    const machines = Option.getOrUndefined(yield* Effect.serviceOption(WorkerHosts));
    const providerPr = yield* Pr;
    const refreshes = yield* GitRefresh;
    const recheckMs = yield* MergeRecheckMs;
    const recheck = Effect.sleep(Duration.millis(recheckMs));
    const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
    const localChecks = Option.getOrUndefined(yield* Effect.serviceOption(LocalChecks));
    const settleChecks = makeCheckSettle(localChecks);
    const freezes = yield* MergeFreezes;
    const frozenFor = (by: Thread, pr: Pick<BoundPr, "repo" | "number">, base?: string) =>
      freezes
        .holding(pr.repo, base, pr.number, by.workspaceId)
        .pipe(Effect.map((freeze) => (freeze === undefined ? undefined : mergeFreezeText(freeze))));

    const declaredCiOnlyFor = (thread: Thread) =>
      isLocalHost(thread.checkout) || localChecks === undefined
        ? Effect.succeed(false)
        : localChecks
            .configuration(checkSiteOf(thread.checkout, thread.checkout.path), thread.projectId)
            .pipe(Effect.map((found) => found.declaredCiOnly === true));

    const localCheckFor = (thread: Thread, badge: PrStatus) =>
      Effect.gen(function* () {
        if (localChecks === undefined) return undefined;
        const found = yield* localChecks.lookup(
          yield* checkSiteFor(thread, repoDirOf(thread)),
          badge.headRefOid,
          currentBaseOf(badge),
          thread.projectId,
        );
        const cutoff =
          thread.boundPr === undefined
            ? undefined
            : verificationAfter.get(baseKey(thread.boundPr.repo, badge.baseRef));
        return found?.status === "passed" && (cutoff === undefined || found.startedAt > cutoff)
          ? found
          : undefined;
      });

    const policyFor = (thread: Thread, repo: string) =>
      Effect.gen(function* () {
        const workspace =
          thread.workspaceId === undefined
            ? undefined
            : yield* store
                .getWorkspace(thread.workspaceId)
                .pipe(Effect.orElseSucceed(() => undefined));
        const bots = reviewBotsOf(yield* store.getSettings);
        return {
          paused: workspace?.paused !== undefined,
          policy: mergeReviewPolicyOf(workspace?.charter, repo, bots),
          bots,
        };
      });

    const blockerFor = (
      thread: Thread,
      repo: string,
      intent: MergeIntent,
      badge: PrStatus,
      known?: { readonly localCheck: LocalCheck | undefined },
    ) =>
      Effect.gen(function* () {
        const { paused, policy, bots } = yield* policyFor(thread, repo);
        if (paused) return PAUSED_BLOCKER;
        const localCheck =
          policy !== "solo"
            ? undefined
            : known !== undefined
              ? known.localCheck
              : yield* localCheckFor(thread, badge);
        const declaredCi = policy === "solo" && (yield* declaredCiOnlyFor(thread));
        return mergeBlocker(intent, badge, policy, bots, localCheck, declaredCi);
      });

    const reusedIdentityScope = (
      thread: Thread,
      bound: BoundPr,
      intent: MergeIntent,
      head: string,
    ) =>
      Effect.gen(function* () {
        const approval = intent.userAuthorization;
        if (approval?.reused !== true || orchestration === undefined) return undefined;
        const scope = yield* store.getThreadWithAuthority(thread.id, approval.callerId);
        if (
          !userMergeAuthorizationMatches(approval.callerId, scope.thread, bound, intent.method) ||
          !userMergeDelegationIsLive(approval.callerId, scope.thread, scope.context)
        )
          return undefined;
        if (
          !(yield* workerPrIdentity(scope.thread, bound.repo, bound.number, head).pipe(
            Effect.provideService(ThreadStore, store),
            Effect.provideService(Proc, proc),
            withMachines(machines),
          ))
        )
          return undefined;
        return scope;
      });

    const attempts = yield* FiberMap.make<ThreadId>();
    const attemptHeads = new Map<ThreadId, string>();
    const locks = makeKeyedLock<ThreadId>();
    const serial = locks.withLock;
    const baseLocks = makeKeyedLock<string>();
    const movedBases = new Map<string, Array<string>>();
    const verificationAfter = new Map<string, number>();
    const restored = yield* store.listMergeFences;
    const unsettled = new Map<string, PendingMerge>();
    for (const record of restored) {
      movedBases.set(record.key, [...record.moved]);
      if (record.verifyAfter !== undefined) verificationAfter.set(record.key, record.verifyAfter);
      if (record.pending !== undefined) unsettled.set(record.key, record.pending);
    }
    const turns = new Map<string, BaseTurn>();
    const aftermath = yield* FiberMap.make<string>();
    const baseMoved = (key: string, oid: string) => {
      const moved = (movedBases.get(key) ?? []).filter((each) => each !== oid);
      movedBases.set(key, [...moved, oid].slice(-MOVED_BASES_KEPT));
      turns.delete(key);
    };

    const run = (cwd: string, args: ReadonlyArray<string>) =>
      gh(cwd, args).pipe(Effect.provideService(Proc, proc));

    const readBase = (cwd: string, repo: string, branch: string) =>
      run(cwd, ["api", `repos/${repo}/branches/${encodeURIComponent(branch)}`]).pipe(
        Effect.flatMap((out) =>
          Effect.try({
            try: () =>
              out.status === 0 && !out.truncated
                ? Schema.decodeUnknownSync(
                    Schema.Struct({ commit: Schema.Struct({ sha: Schema.NonEmptyString }) }),
                  )(JSON.parse(out.stdout)).commit.sha
                : undefined,
            catch: () => undefined,
          }),
        ),
        Effect.orElseSucceed(() => undefined),
      );

    const writeFence = (key: string, pending?: PendingMerge, moved = movedBases.get(key) ?? []) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const cutoff = verificationAfter.get(key);
          const record: MergeFence = {
            key,
            moved,
            ...(cutoff === undefined ? {} : { verifyAfter: cutoff }),
            ...(pending === undefined ? {} : { pending }),
          };
          yield* store.putMergeFence(record);
          movedBases.set(key, [...moved]);
          if (pending === undefined) unsettled.delete(key);
          else unsettled.set(key, pending);
        }),
      );

    const reserveFence = (
      key: string,
      pending: PendingMerge,
      authorized: (thread: Thread | undefined, context: ThreadUpdateContext | undefined) => boolean,
      authorityCaller: ThreadId,
      moved = movedBases.get(key) ?? [],
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const cutoff = verificationAfter.get(key);
          const record: MergeFence = {
            key,
            moved,
            ...(cutoff === undefined ? {} : { verifyAfter: cutoff }),
            pending,
          };
          const reserved = yield* store.reserveMergeFence(
            record,
            pending.pr,
            pending.threadId,
            authorized,
            authorityCaller,
          );
          if (reserved) {
            movedBases.set(key, [...moved]);
            unsettled.set(key, pending);
          }
          return reserved;
        }),
      );

    const observedMerge = Schema.Struct({ state: Schema.String, headRefOid: Schema.String });
    const settle = (key: string, cwd: string) =>
      Effect.gen(function* () {
        const merge = unsettled.get(key);
        if (merge === undefined) return undefined;
        const state = yield* run(cwd, [
          "pr",
          "view",
          String(merge.pr.number),
          "--repo",
          merge.pr.repo,
          "--json",
          "state,headRefOid",
        ]).pipe(
          forThread(merge.threadId),
          Effect.flatMap((out) =>
            Effect.try(() =>
              out.status === 0
                ? Schema.decodeUnknownSync(observedMerge)(JSON.parse(out.stdout))
                : undefined,
            ),
          ),
          Effect.orElseSucceed(() => undefined),
        );
        if (state?.headRefOid !== merge.head) return merge;
        if (state.state === "MERGED") {
          const moved =
            merge.tip === undefined
              ? (movedBases.get(key) ?? [])
              : [
                  ...(movedBases.get(key) ?? []).filter((tip) => tip !== merge.tip),
                  merge.tip,
                ].slice(-MOVED_BASES_KEPT);
          yield* writeFence(key, undefined, moved);
          yield* clearFenceWait(merge);
          if (merge.tip !== undefined) baseMoved(key, merge.tip);
          return "merged" as const;
        }
        if (state.state !== "OPEN" || merge.confirmedFailure !== true) return merge;
        yield* writeFence(key);
        yield* clearFenceWait(merge);
        return undefined;
      });

    const unmerged = (cwd: string, after: ReadonlyArray<Pick<BoundPr, "repo" | "number">>) =>
      Effect.filter(after, (pr) =>
        run(cwd, [
          "pr",
          "view",
          String(pr.number),
          "--repo",
          pr.repo,
          "--json",
          "state",
          "--jq",
          ".state",
        ]).pipe(
          Effect.map((out) => out.status !== 0 || out.stdout.trim() !== "MERGED"),
          Effect.orElseSucceed(() => true),
        ),
      );

    const setIntent = (
      threadId: ThreadId,
      bound: BoundPr,
      change: (intent: MergeIntent) => MergeIntent | undefined,
      setAt?: number,
    ) =>
      runtimes
        .updateThread(threadId, (t) => {
          const current = t.boundPr;
          if (current === undefined || !samePr(current, bound)) return t;
          const intent = current.mergeWhenReady;
          if (intent === undefined || (setAt !== undefined && intent.setAt !== setAt)) return t;
          const next = change(intent);
          const { mergeWhenReady: _, ...rest } = current;
          if (next !== undefined) return { ...t, boundPr: { ...rest, mergeWhenReady: next } };
          if ([...unsettled.values()].some((p) => p.threadId === threadId && samePr(p.pr, bound)))
            return { ...t, boundPr: rest };
          const { mergeWaiting: __, ...done } = rest;
          return { ...t, boundPr: done };
        })
        .pipe(Effect.ignore);

    const tell = (
      thread: Thread,
      bound: Pick<BoundPr, "repo" | "number">,
      text: string,
      about = "merge",
    ) =>
      runtimes
        .sendNotice(thread.id, `${about}:${prName(bound)}`, { text })
        .pipe(
          Effect.catch((e) =>
            Effect.logWarning("merge_when_ready notice not sent").pipe(
              Effect.annotateLogs({ threadId: thread.id, error: e.message }),
            ),
          ),
        );

    const noteWait = (
      thread: Thread,
      bound: Pick<BoundPr, "repo" | "number">,
      why: string | undefined,
      loud = false,
    ) =>
      Effect.gen(function* () {
        const current = (yield* store.getThread(thread.id)).boundPr;
        if (current === undefined || !samePr(current, bound)) return;
        const pending = [...unsettled.values()].find(
          (p) => p.threadId === thread.id && samePr(p.pr, bound),
        );
        if (pending !== undefined) why = uncertaintyText(pending);
        if (current.mergeWhenReady === undefined && pending === undefined && why !== undefined)
          return;
        const last = current.mergeWaiting;
        if (why === undefined && last === undefined) return;
        const now = yield* Clock.currentTimeMillis;
        const same = last !== undefined && last.why === why ? last : undefined;
        const since = same?.since ?? now;
        const telling =
          why !== undefined &&
          same?.told !== true &&
          (pending !== undefined || (loud && now - since >= RECHECKS_BEFORE_TELLING * recheckMs));
        if (same !== undefined && !telling) return;
        yield* runtimes.updateThread(thread.id, (t) => {
          if (t.boundPr === undefined || !samePr(t.boundPr, bound)) return t;
          const { mergeWaiting: _, ...rest } = t.boundPr;
          return {
            ...t,
            boundPr:
              why === undefined
                ? rest
                : {
                    ...rest,
                    mergeWaiting: {
                      why,
                      since,
                      ...(telling ? { told: true as const } : {}),
                    },
                  },
          };
        });
        if (!telling || why === undefined) return;
        yield* Effect.logWarning("merge_when_ready still waits").pipe(
          Effect.annotateLogs({ threadId: thread.id, pr: prName(bound), why }),
        );
        yield* tell(
          thread,
          bound,
          waitingText(bound, why),
          pending === undefined ? "merge" : `merge-fence:${pending.head}`,
        ).pipe(Effect.asVoid);
      }).pipe(
        Effect.catch((e) =>
          Effect.logWarning("merge_when_ready wait not recorded").pipe(
            Effect.annotateLogs({ threadId: thread.id, error: e.message }),
          ),
        ),
      );

    const clearFenceWait = (pending: PendingMerge) =>
      Effect.gen(function* () {
        const owner = yield* store
          .getThread(pending.threadId)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (owner !== undefined) yield* noteWait(owner, pending.pr, undefined);
      });

    const watchFence = (key: string): Effect.Effect<void> =>
      FiberMap.run(
        aftermath,
        `fence:${key}`,
        Effect.gen(function* () {
          while (true) {
            const pending = unsettled.get(key);
            if (pending === undefined) return;
            const owner = yield* store
              .getThread(pending.threadId)
              .pipe(Effect.orElseSucceed(() => undefined));
            if (owner !== undefined) {
              yield* noteWait(owner, pending.pr, uncertaintyText(pending));
              const settled = yield* baseLocks.withLock(key, settle(key, yield* ghDirOf(owner)));
              if (settled === undefined || settled === "merged") {
                yield* noteWait(owner, pending.pr, undefined);
                yield* afterMerge(owner.id, pending.pr);
                return;
              }
            }
            yield* recheck;
          }
        }),
        { onlyIfMissing: true },
      ).pipe(Effect.asVoid);

    const attempt = (threadId: ThreadId, head: string, tries = 0): Effect.Effect<void> =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId).pipe(Effect.option);
        if (
          Option.isNone(thread) ||
          thread.value.parked ||
          thread.value.babysit?.phase === "watching"
        )
          return;
        const bound = thread.value.boundPr;
        const intent = bound?.mergeWhenReady;
        if (bound === undefined || intent === undefined) return;
        const badge = yield* publisher.badgeFor(thread.value);
        if (badge === undefined || !isBadgeOf(badge, bound) || badge.headRefOid !== head) return;
        if ((yield* blockerFor(thread.value, bound.repo, intent, badge)) !== undefined) return;
        const frozen = yield* frozenFor(thread.value, bound, badge.baseRef);
        if (frozen !== undefined) return yield* noteWait(thread.value, bound, frozen);
        const cwd = thread.value.checkout.path;
        const ghCwd = yield* ghDirOf(thread.value);
        const after = [
          ...(intent.after ?? []),
          ...mergeAfterDependencies(bound).filter(
            (dependency) => !(intent.after ?? []).some((each) => samePr(each, dependency)),
          ),
        ];
        const waiting = yield* unmerged(ghCwd, after);
        if (waiting.length > 0) {
          yield* Effect.logDebug("merge_when_ready waits").pipe(
            Effect.annotateLogs({ threadId, after: waiting.map(prName).join(" ") }),
          );
          yield* noteWait(
            thread.value,
            bound,
            `${waiting.map(prName).join(", ")} must merge first`,
          );
          return yield* recheck.pipe(Effect.andThen(Effect.suspend(() => attempt(threadId, head))));
        }
        let launchedLocalCheck: LocalCheck | undefined;
        let foundMerged = false;
        const launched = yield* serial(
          threadId,
          Effect.gen(function* () {
            const now = yield* store.getThread(threadId).pipe(Effect.option);
            const standing = Option.isSome(now) ? now.value.boundPr : undefined;
            if (
              Option.isNone(now) ||
              now.value.parked ||
              now.value.babysit?.phase === "watching" ||
              standing === undefined ||
              !samePr(standing, bound) ||
              standing.mergeWhenReady?.setAt !== intent.setAt ||
              standing.mergeWhenReady.hold !== undefined ||
              (standing.mergeWhenReady.failedOn ?? "") !== (intent.failedOn ?? "")
            )
              return undefined;
            const afterNow = [
              ...(standing.mergeWhenReady.after ?? []),
              ...mergeAfterDependencies(standing).filter(
                (dependency) =>
                  !(standing.mergeWhenReady?.after ?? []).some((each) => samePr(each, dependency)),
              ),
            ];
            const waitingAfter = yield* unmerged(ghCwd, afterNow);
            if (waitingAfter.length > 0) return { waitingAfter } as const;
            const reusedScope = yield* reusedIdentityScope(now.value, bound, intent, head);
            if (intent.userAuthorization?.reused === true && reusedScope === undefined)
              return undefined;
            let owned:
              | {
                  readonly projects: string;
                  readonly folders: string;
                  readonly at: {
                    readonly path: string;
                    readonly hostId?: string;
                    readonly branch: string;
                  };
                }
              | undefined;
            if (intent.allowedBy === "autonomy") {
              const workspace =
                now.value.workspaceId === undefined
                  ? undefined
                  : yield* store
                      .getWorkspace(now.value.workspaceId)
                      .pipe(Effect.orElseSucceed(() => undefined));
              if (workspace?.paused !== undefined) return undefined;
              let why: string | undefined;
              let fix: string | undefined;
              if (workspace === undefined) why = "the worker no longer belongs to a workspace";
              else if (autonomyOf(workspace.charter) !== "full")
                why = "the workspace's autonomy is no longer full";
              else if (featurePaused(workspace, now.value))
                why = `the user paused feature ${now.value.spawnedBy?.feature}`;
              else if (
                orchestration === undefined ||
                !(yield* orchestration.workerMergesOwn(threadId))
              )
                why = "orchestration no longer delegates merges to this worker";
              else {
                const found = yield* workerPrOwnership(
                  now.value,
                  bound.repo,
                  bound.number,
                  head,
                ).pipe(
                  Effect.provideService(ThreadStore, store),
                  Effect.provideService(Proc, proc),
                  withMachines(machines),
                );
                const ownership = typeof found === "string" ? found : undefined;
                if (typeof found === "object")
                  owned = {
                    projects: JSON.stringify(workspace.workspace.projectIds),
                    folders: JSON.stringify([now.value.checkout, now.value.extraCheckouts]),
                    at: found,
                  };
                if (ownership !== undefined) {
                  why = `the pull request is no longer this worker's own: ${explainOwnershipBlocker(ownership).reason}`;
                  fix = ownershipFix(ownership, "worker");
                }
              }
              if (why !== undefined) {
                yield* setIntent(threadId, bound, () => undefined, intent.setAt);
                yield* tell(
                  thread.value,
                  bound,
                  `merge_when_ready on ${prName(bound)} was dropped: ${why}. Ask for it again if it should still merge.${fix === undefined ? "" : ` ${fix}`}`,
                );
                return undefined;
              }
            }
            const standingIntent = standing.mergeWhenReady;
            const launchOnto = (baseRef: string | undefined) => {
              const key = baseKey(bound.repo, baseRef);
              return baseLocks.withLock(
                key,
                freezes.fence(
                  bound.repo,
                  Effect.gen(function* () {
                    const { policy } = yield* policyFor(now.value, bound.repo);
                    const localCheck =
                      policy === "solo" ? yield* localCheckFor(now.value, badge) : undefined;
                    const declaredCi = policy === "solo" && (yield* declaredCiOnlyFor(now.value));
                    const read = yield* providerPr
                      .status(
                        ghCwd,
                        { repo: bound.repo, number: bound.number, reviews: true },
                        undefined,
                        {
                          fresh: true,
                          forMerge: true,
                          ...(localCheck === undefined ? {} : { localCheckHead: localCheck.head }),
                          ...(declaredCi ? { declaredCi: true } : {}),
                        },
                      )
                      .pipe(Effect.option);
                    if (Option.isNone(read)) return { unread: true } as const;
                    const fresh = read.value;
                    if (
                      fresh === undefined ||
                      !isBadgeOf(fresh, bound) ||
                      fresh.headRefOid !== head
                    )
                      return undefined;
                    if (declaredCi && fresh.mergeCiDeclared !== true)
                      return { undeclared: fresh.baseRef ?? "its base" } as const;
                    if (fresh.baseRef !== baseRef) return { retarget: fresh.baseRef } as const;
                    const settled = yield* settle(key, ghCwd);
                    if (settled === "merged") foundMerged = true;
                    else if (settled !== undefined) return { unsettled: settled.pr } as const;
                    if (verificationAfter.has(key)) {
                      if (fresh.baseRef === undefined) return { unread: true } as const;
                      const verified = yield* readBase(ghCwd, bound.repo, fresh.baseRef);
                      if (verified === undefined || currentBaseOf(fresh) !== verified)
                        return { unread: true } as const;
                    }
                    const tip = currentBaseOf(fresh);
                    if (tip !== undefined && movedBases.get(key)?.includes(tip))
                      return { lagging: tip } as const;
                    if (localCheck !== undefined && tip !== localCheck.base)
                      return { recheck: fresh } as const;
                    if (
                      (localCheck !== undefined &&
                        (yield* policyFor(now.value, bound.repo)).policy !== "solo") ||
                      (yield* blockerFor(now.value, bound.repo, standingIntent, fresh, {
                        localCheck,
                      })) !== undefined
                    )
                      return undefined;
                    if (
                      localCheck !== undefined &&
                      (yield* localCheckFor(now.value, fresh)) !== localCheck
                    )
                      return undefined;
                    launchedLocalCheck = localCheck;
                    const latest = yield* store.getThread(threadId);
                    const latestBound = latest.boundPr;
                    const latestWorkspace =
                      latest.workspaceId === undefined
                        ? undefined
                        : yield* store
                            .getWorkspace(latest.workspaceId)
                            .pipe(Effect.orElseSucceed(() => undefined));
                    if (
                      latestWorkspace?.paused !== undefined ||
                      latest.parked ||
                      latest.babysit?.phase === "watching" ||
                      latestBound === undefined ||
                      !samePr(latestBound, bound) ||
                      latestBound.mergeWhenReady?.setAt !== intent.setAt ||
                      latestBound.mergeWhenReady.hold !== undefined
                    )
                      return undefined;
                    if (intent.allowedBy === "autonomy") {
                      const workspace =
                        latest.workspaceId === undefined
                          ? undefined
                          : yield* store
                              .getWorkspace(latest.workspaceId)
                              .pipe(Effect.orElseSucceed(() => undefined));
                      if (
                        workspace === undefined ||
                        owned === undefined ||
                        JSON.stringify(workspace.workspace.projectIds) !== owned.projects ||
                        JSON.stringify([latest.checkout, latest.extraCheckouts]) !==
                          owned.folders ||
                        autonomyOf(workspace.charter) !== "full" ||
                        workspace.paused !== undefined ||
                        featurePaused(workspace, latest) ||
                        orchestration === undefined ||
                        !(yield* orchestration.workerMergesOwn(threadId)) ||
                        (yield* ownedPrNoLongerStands(
                          latest,
                          bound.repo,
                          bound.number,
                          owned.at,
                          prHostOf(fresh.url),
                        ).pipe(
                          Effect.provideService(ThreadStore, store),
                          Effect.provideService(Proc, proc),
                        ))
                      )
                        return undefined;
                    }
                    if (reusedScope !== undefined) {
                      const approval = intent.userAuthorization!;
                      const final = yield* store.getThreadWithAuthority(
                        threadId,
                        approval.callerId,
                      );
                      if (
                        !userMergeAuthorizationMatches(
                          approval.callerId,
                          final.thread,
                          bound,
                          intent.method,
                        ) ||
                        !userMergeDelegationIsLive(
                          approval.callerId,
                          final.thread,
                          final.context,
                        ) ||
                        JSON.stringify(final.thread.boundPr?.mergeWhenReady) !==
                          JSON.stringify(intent) ||
                        JSON.stringify(final.thread.checkout) !==
                          JSON.stringify(reusedScope.thread.checkout) ||
                        JSON.stringify(final.thread.extraCheckouts) !==
                          JSON.stringify(reusedScope.thread.extraCheckouts) ||
                        JSON.stringify(final.context.workspace?.workspace.projectIds) !==
                          JSON.stringify(reusedScope.context.workspace?.workspace.projectIds) ||
                        mergeBlocker(
                          intent,
                          fresh,
                          mergeReviewPolicyOf(
                            final.context.workspace?.charter,
                            bound.repo,
                            reviewBotsOf(final.context.settings),
                          ),
                          reviewBotsOf(final.context.settings),
                          localCheck,
                          declaredCi,
                        ) !== undefined
                      )
                        return undefined;
                    }
                    if (
                      localCheck !== undefined &&
                      (yield* localCheckFor(latest, fresh)) !== localCheck
                    )
                      return undefined;
                    const frozenNow = yield* frozenFor(latest, bound, fresh.baseRef);
                    if (frozenNow !== undefined) return { frozen: frozenNow } as const;
                    const stillAuthorized = (
                      current: Thread | undefined,
                      context: ThreadUpdateContext | undefined,
                    ): boolean => {
                      const binding = current?.boundPr;
                      if (
                        current === undefined ||
                        context === undefined ||
                        current.parked ||
                        current.babysit?.phase === "watching" ||
                        binding === undefined ||
                        !samePr(binding, bound) ||
                        binding.mergeWhenReady?.setAt !== intent.setAt ||
                        binding.mergeWhenReady.hold !== undefined ||
                        context.workspace?.paused !== undefined
                      )
                        return false;
                      if (intent.allowedBy === "autonomy")
                        return (
                          owned !== undefined &&
                          mergeDelegationStands({
                            callerId: threadId,
                            caller: context.caller,
                            target: current,
                            state: context.workspace,
                          }) &&
                          JSON.stringify(context.workspace?.workspace.projectIds) ===
                            owned.projects &&
                          JSON.stringify([current.checkout, current.extraCheckouts]) ===
                            owned.folders
                        );
                      if (intent.userAuthorization?.reused === true) {
                        const approval = intent.userAuthorization;
                        return (
                          reusedScope !== undefined &&
                          userMergeAuthorizationMatches(
                            approval.callerId,
                            current,
                            bound,
                            intent.method,
                          ) &&
                          userMergeDelegationIsLive(approval.callerId, current, context) &&
                          JSON.stringify(binding.mergeWhenReady) === JSON.stringify(intent) &&
                          JSON.stringify(current.checkout) ===
                            JSON.stringify(reusedScope.thread.checkout) &&
                          JSON.stringify(current.extraCheckouts) ===
                            JSON.stringify(reusedScope.thread.extraCheckouts) &&
                          JSON.stringify(context.workspace?.workspace.projectIds) ===
                            JSON.stringify(reusedScope.context.workspace?.workspace.projectIds)
                        );
                      }
                      return true;
                    };
                    const reservedBranch = owned?.at.branch ?? fresh.headRef;
                    const merge = Effect.gen(function* () {
                      const reserved = yield* reserveFence(
                        key,
                        {
                          pr: { repo: bound.repo, number: bound.number },
                          threadId,
                          head,
                          ...(reservedBranch === undefined ? {} : { branch: reservedBranch }),
                          ...(tip === undefined ? {} : { tip }),
                          at: yield* Clock.currentTimeMillis,
                        },
                        stillAuthorized,
                        intent.userAuthorization?.reused === true
                          ? intent.userAuthorization.callerId
                          : threadId,
                      );
                      if (!reserved) return { claimed: true } as const;
                      return yield* run(ghCwd, [
                        "pr",
                        "merge",
                        String(bound.number),
                        `--${intent.method}`,
                        "--match-head-commit",
                        head,
                        "--repo",
                        bound.repo,
                      ]).pipe(
                        Effect.map((out) => ({ out })),
                        Effect.catch((e) => Effect.succeed({ lost: e.message })),
                        Effect.tap((result) =>
                          Effect.uninterruptible(
                            Effect.gen(function* () {
                              if (
                                "out" in result &&
                                result.out.status !== 0 &&
                                result.out.stderr.trim() ===
                                  "GraphQL: Pull Request is not mergeable (mergePullRequest)"
                              ) {
                                yield* writeFence(key, {
                                  ...unsettled.get(key)!,
                                  confirmedFailure: true,
                                });
                              }
                              if ("out" in result && result.out.status === 0 && tip !== undefined) {
                                baseMoved(key, tip);
                                yield* writeFence(key, unsettled.get(key));
                              }
                              yield* settle(key, ghCwd);
                              if (unsettled.has(key)) yield* watchFence(key);
                              if ("out" in result && result.out.status === 0)
                                yield* FiberMap.run(
                                  aftermath,
                                  `merged\u0000${threadId}\u0000${head}`,
                                  afterMerge(threadId, bound),
                                );
                            }),
                          ),
                        ),
                        Effect.onInterrupt(() => watchFence(key)),
                      );
                    });
                    return latest.workspaceId === undefined || orchestration === undefined
                      ? yield* merge
                      : yield* orchestration.launchUnlessPaused(latest.workspaceId, merge);
                  }),
                ),
              );
            };
            const first = yield* launchOnto(badge.baseRef);
            if (first === undefined || !("retarget" in first)) return first;
            const second = yield* launchOnto(first.retarget);
            return second !== undefined && "retarget" in second ? undefined : second;
          }),
        );
        if (foundMerged)
          yield* FiberMap.run(aftermath, `found\u0000${threadId}`, afterMerge(threadId, bound), {
            onlyIfMissing: true,
          });
        if (launched === undefined) return yield* noteWait(thread.value, bound, undefined);
        if ("waitingAfter" in launched) {
          yield* Effect.logDebug("merge_when_ready waits").pipe(
            Effect.annotateLogs({ threadId, after: launched.waitingAfter.map(prName).join(" ") }),
          );
          yield* noteWait(
            thread.value,
            bound,
            `${launched.waitingAfter.map(prName).join(", ")} must merge first`,
          );
          return yield* recheck.pipe(Effect.andThen(Effect.suspend(() => attempt(threadId, head))));
        }
        if ("claimed" in launched) {
          yield* noteWait(
            thread.value,
            bound,
            "another thread bound it or its merge's authority changed just before the launch",
          );
          return yield* recheck.pipe(Effect.andThen(Effect.suspend(() => attempt(threadId, head))));
        }
        if ("frozen" in launched) return yield* noteWait(thread.value, bound, launched.frozen);
        if ("undeclared" in launched) {
          yield* setIntent(
            threadId,
            bound,
            (current) => ({ ...current, failedOn: head }),
            intent.setAt,
          );
          return yield* tell(
            thread.value,
            bound,
            refusedText(
              bound,
              head,
              `${launched.undeclared} declares no merge CI (.gram/merge-ci.json), and a PR from a provisioned machine merges only on the CI its base declares; a worker on one of the user's own machines can take it over`,
            ),
          );
        }
        if ("recheck" in launched) {
          yield* refreshes.request(cwd, true, { expectChange: true });
          return yield* noteWait(
            thread.value,
            bound,
            yield* startLocalCheck(thread.value, bound, intent, launched.recheck),
          );
        }
        if ("lagging" in launched || "unread" in launched || "unsettled" in launched) {
          yield* noteWait(
            thread.value,
            bound,
            "lagging" in launched
              ? `GitHub still reads ${launched.lagging.slice(0, 7)} as the tip of ${badge.baseRef ?? "its base"}, which a merge by Gram moved on from`
              : "unread" in launched
                ? "its state on GitHub couldn't be read"
                : `whether ${prName(launched.unsettled)} merged isn't known yet, and that decides the base`,
            true,
          );
          return yield* recheck.pipe(
            Effect.andThen(Effect.suspend(() => attempt(threadId, head, tries))),
          );
        }
        yield* noteWait(thread.value, bound, undefined);
        if ("lost" in launched) {
          invalidatePrBadges();
          yield* refreshes.request(cwd, true, { expectChange: true });
          yield* Effect.logWarning("merge_when_ready launch failed").pipe(
            Effect.annotateLogs({ threadId, error: launched.lost, tries }),
          );
          if (tries + 1 >= LAUNCH_TRIES) {
            yield* setIntent(
              threadId,
              bound,
              (current) => ({ ...current, failedOn: head }),
              intent.setAt,
            );
            return yield* tell(
              thread.value,
              bound,
              refusedText(bound, head, `gh failed ${LAUNCH_TRIES} times (${launched.lost})`),
            );
          }
          return yield* recheck.pipe(
            Effect.andThen(Effect.suspend(() => attempt(threadId, head, tries + 1))),
          );
        }
        const out = launched.out;
        invalidatePrBadges();
        yield* refreshes.request(cwd, true, { expectChange: true });
        if (out.status !== 0) {
          const why = gitFailMsg(out, "gh pr merge failed");
          yield* setIntent(
            threadId,
            bound,
            (current) => ({ ...current, failedOn: head }),
            intent.setAt,
          );
          yield* Effect.logInfo("merge_when_ready refused").pipe(
            Effect.annotateLogs({ threadId, pr: prName(bound) }),
          );
          return yield* tell(thread.value, bound, refusedText(bound, head, why));
        }
        yield* setIntent(threadId, bound, () => undefined, intent.setAt);
        yield* Effect.logInfo("merge_when_ready merged").pipe(
          Effect.annotateLogs({ threadId, pr: prName(bound), head }),
        );
        const configuration =
          localChecks === undefined
            ? undefined
            : yield* localChecks.configuration(
                yield* checkSiteFor(thread.value, Effect.succeed(cwd)),
                thread.value.projectId,
              );
        const gateNotice =
          (yield* policyFor(thread.value, bound.repo)).policy === "solo" &&
          configuration?.config === undefined
            ? configuration?.reason
            : undefined;
        if (gateNotice !== undefined && thread.value.workspaceId !== undefined)
          yield* store.appendOrchestrationEvent(thread.value.workspaceId, {
            at: yield* Clock.currentTimeMillis,
            kind: "merge",
            data: { threadId, pr: prName(bound), head, localGate: "off", reason: gateNotice },
          });
        yield* tell(
          thread.value,
          bound,
          mergedText(bound, intent, head, launchedLocalCheck, gateNotice),
        );
        if (!agentOwnsPrEvents(thread.value))
          yield* hub.publish({
            type: "notify",
            kind: "done",
            title: `Merged ${prName(bound)}`,
            body: thread.value.title,
            threadId,
          });
      }).pipe(
        Effect.catch((e) =>
          Effect.logWarning("merge_when_ready attempt failed").pipe(
            Effect.annotateLogs({ threadId, error: e.message }),
          ),
        ),
        forThread(threadId),
      );

    const lookAfresh = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId).pipe(Effect.option);
        const bound = Option.isSome(thread) ? thread.value.boundPr : undefined;
        if (Option.isNone(thread) || bound?.mergeWhenReady === undefined) return;
        const read = yield* providerPr
          .status(
            yield* ghDirOf(thread.value),
            { repo: bound.repo, number: bound.number, reviews: true },
            undefined,
            { fresh: true },
          )
          .pipe(Effect.orElseSucceed(() => undefined));
        yield* stop(threadId);
        yield* evaluate(thread.value, read ?? (yield* publisher.badgeFor(thread.value)));
      }).pipe(forThread(threadId));

    const afterMerge = (threadId: ThreadId, bound: Pick<BoundPr, "repo" | "number">) =>
      Effect.gen(function* () {
        const others = (yield* store.listThreads)
          .filter(
            (other) =>
              other.id !== threadId &&
              other.boundPr?.mergeWhenReady !== undefined &&
              other.boundPr.repo.toLowerCase() === bound.repo.toLowerCase(),
          )
          .toSorted((a, b) => a.boundPr!.mergeWhenReady!.setAt - b.boundPr!.mergeWhenReady!.setAt);
        for (const other of others) {
          yield* refreshes.request(other.checkout.path, true, { expectChange: true });
          yield* lookAfresh(other.id);
        }
      });

    const turnOver = (key: string, listener: string, wait: Effect.Effect<void> = Effect.void) =>
      FiberMap.run(
        aftermath,
        listener,
        Effect.gen(function* () {
          yield* wait;
          const turn = turns.get(key);
          if (turn?.listener !== listener) return;
          turns.delete(key);
          for (const threadId of turn.queued) yield* lookAfresh(threadId);
        }),
        { onlyIfMissing: true },
      );

    const stop = (threadId: ThreadId) => {
      attemptHeads.delete(threadId);
      return FiberMap.remove(attempts, threadId);
    };

    const listening = new Set<string>();
    const turnLocks = makeKeyedLock<string>();

    const claimTurn = (
      key: string,
      threadId: ThreadId,
      bound: BoundPr,
      listener: string,
    ): Effect.Effect<"claimed" | "running" | { readonly waits: string }> =>
      turnLocks.withLock(
        key,
        Effect.gen(function* () {
          if (listening.has(listener)) return "running" as const;
          const take = (queued: Set<ThreadId>) => {
            turns.set(key, { threadId, pr: bound, listener, queued });
            listening.add(listener);
            return "claimed" as const;
          };
          const turn = turns.get(key);
          if (turn === undefined || turn.threadId === threadId)
            return take(turn?.queued ?? new Set());
          const waits = {
            waits: `its check waits for ${prName(turn.pr)}, whose merge would move the base`,
          };
          const queue = () => {
            turn.queued.add(threadId);
            return waits;
          };
          if (listening.has(turn.listener)) return queue();
          const verdict = yield* serial(
            turn.threadId,
            Effect.gen(function* () {
              const holder = yield* store.getThread(turn.threadId).pipe(Effect.option);
              if (turns.get(key) !== turn) return "gone" as const;
              const armed =
                Option.isSome(holder) &&
                holder.value.boundPr !== undefined &&
                samePr(holder.value.boundPr, turn.pr) &&
                holder.value.boundPr.mergeWhenReady !== undefined;
              if (armed) return "held" as const;
              return take(turn.queued);
            }),
          );
          if (verdict === "held") return queue();
          return verdict === "gone" ? take(turn.queued) : verdict;
        }),
      );
    const provenanceVerified = new Set<string>();
    const checkProvenance = (
      thread: Thread,
      bound: BoundPr,
      badge: PrStatus,
      head: string,
      intent: MergeIntent | undefined,
    ): Effect.Effect<string | undefined> =>
      Effect.gen(function* () {
        if (
          intent?.allowedBy === "user" &&
          intent.approved?.head === head &&
          approvalBlocker(intent, badge) === undefined
        )
          return undefined;
        const key = `${thread.id}\u0000${head}\u0000${currentBaseOf(badge) ?? ""}`;
        if (provenanceVerified.has(key)) return undefined;
        const blocker = yield* workerPrBlocker(thread, bound.repo, bound.number, head).pipe(
          Effect.provideService(ThreadStore, store),
          Effect.provideService(Proc, proc),
          withMachines(machines),
          Effect.orElseSucceed(() => OWNERSHIP_BLOCKERS.unverified),
        );
        if (blocker === undefined) {
          if (provenanceVerified.size >= 1_000) provenanceVerified.clear();
          provenanceVerified.add(key);
        }
        return blocker;
      });

    const startLocalCheck = (
      thread: Thread,
      bound: BoundPr,
      intent: MergeIntent,
      badge: PrStatus,
    ): Effect.Effect<string | undefined> =>
      Effect.gen(function* () {
        const head = badge.headRefOid;
        const base = currentBaseOf(badge);
        if (localChecks === undefined || head === undefined || base === undefined) return undefined;
        if (intent.hold !== undefined || intent.failedOn === head) return undefined;
        const { paused, policy, bots } = yield* policyFor(thread, bound.repo);
        if (paused || policy !== "solo") return undefined;
        if (mergeBlocker(intent, badge, "solo", bots, { head, base }) !== undefined)
          return undefined;
        const listener = `${thread.id}\u0000${head}\u0000${base}`;
        if (listening.has(listener)) return undefined;
        const key = baseKey(bound.repo, badge.baseRef);
        if (movedBases.get(key)?.includes(base))
          return `GitHub still reads ${base.slice(0, 7)} as a base Gram moved on from`;
        const provenance = yield* checkProvenance(thread, bound, badge, head, intent);
        if (provenance !== undefined)
          return `Gram doesn't run its own check of ${head.slice(0, 7)} on this machine, since ${prName(bound)} isn't this thread's own (${explainOwnershipBlocker(provenance).reason}) and the user didn't approve merging this head; CI on the head can still satisfy the merge, or ${ASK_AGAIN}`;
        const dir = yield* checkSiteFor(thread, repoDirOf(thread));
        const claim = yield* claimTurn(key, thread.id, bound, listener);
        if (claim === "running") return undefined;
        if (claim !== "claimed") return claim.waits;
        const found = yield* localChecks
          .ensure(dir, head, base, {
            projectId: thread.projectId,
            pr: bound,
            since: intent.setAt,
            ...(verificationAfter.has(key) ? { after: verificationAfter.get(key)! } : {}),
            onDone: (done) =>
              Effect.sync(() => listening.delete(listener)).pipe(
                Effect.andThen(
                  done.status === "passed" || done.cancelled !== undefined
                    ? Effect.void
                    : tell(thread, bound, localCheckFailedText(bound, done), "local-check"),
                ),
                Effect.andThen(Effect.suspend(() => check(thread.id))),
                Effect.andThen(
                  Effect.suspend(() =>
                    turnOver(key, listener, done.status === "passed" ? recheck : Effect.void),
                  ),
                ),
              ),
          })
          .pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => listening.delete(listener)).pipe(
                Effect.andThen(Effect.suspend(() => turnOver(key, listener))),
              ),
            ),
          );
        if (found?.status !== "running") {
          listening.delete(listener);
          yield* turnOver(key, listener);
        }
        return undefined;
      });

    const evaluate = (thread: Thread, badge: PrStatus | undefined): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* settleChecks(thread, badge);
        const bound = thread.boundPr;
        const intent = bound?.mergeWhenReady;
        if (bound === undefined || intent === undefined) return yield* stop(thread.id);
        if (thread.parked || badge === undefined || !isBadgeOf(badge, bound)) return;
        if (thread.babysit?.phase === "watching") return yield* stop(thread.id);
        if (badge.state !== "OPEN") {
          yield* stop(thread.id);
          yield* setIntent(thread.id, bound, () => undefined, intent.setAt);
          if (badge.state === "CLOSED")
            yield* tell(
              thread,
              bound,
              `merge_when_ready on ${prName(bound)} was dropped: the pull request is closed.`,
            );
          return;
        }
        const head = badge.headRefOid;
        const frozen =
          intent.hold === undefined ? yield* frozenFor(thread, bound, badge.baseRef) : undefined;
        if (frozen !== undefined) {
          yield* noteWait(thread, bound, frozen);
          return yield* stop(thread.id);
        }
        const drift =
          intent.hold === undefined && head !== undefined && badge.baseRef !== undefined
            ? approvalBlocker(intent, badge)
            : undefined;
        if (drift !== undefined) {
          if (bound.mergeWaiting?.why !== drift)
            yield* tell(thread, bound, `merge_when_ready on ${prName(bound)} waits: ${drift}.`);
          yield* noteWait(thread, bound, drift);
          return yield* stop(thread.id);
        }
        if (
          (yield* blockerFor(thread, bound.repo, intent, badge)) !== undefined ||
          head === undefined
        ) {
          yield* noteWait(thread, bound, yield* startLocalCheck(thread, bound, intent, badge));
          return yield* stop(thread.id);
        }
        const same = attemptHeads.get(thread.id) === head;
        attemptHeads.set(thread.id, head);
        yield* FiberMap.run(
          attempts,
          thread.id,
          attempt(thread.id, head).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (attemptHeads.get(thread.id) === head) attemptHeads.delete(thread.id);
              }),
            ),
          ),
          { onlyIfMissing: same },
        );
      });

    for (const key of unsettled.keys()) yield* watchFence(key);

    yield* publisher.observe(
      {
        onState: (thread, state: GitState) => evaluate(thread, state.pr),
        onRound: () => Effect.void,
      },
      { replay: true },
    );

    const pausedWorkspaces = new Set(
      (yield* store.listWorkspaces)
        .filter((state) => state.paused !== undefined)
        .map((state) => state.workspace.id),
    );
    const onWorkspaces = Effect.gen(function* () {
      const resumed: Array<string> = [];
      for (const state of yield* store.listWorkspaces) {
        const id = state.workspace.id;
        if (state.paused !== undefined) pausedWorkspaces.add(id);
        else if (pausedWorkspaces.delete(id)) resumed.push(id);
      }
      if (resumed.length === 0) return;
      for (const thread of yield* store.listThreads) {
        if (
          thread.workspaceId !== undefined &&
          resumed.includes(thread.workspaceId) &&
          thread.boundPr?.mergeWhenReady !== undefined
        ) {
          yield* check(thread.id);
        }
      }
    });
    yield* hub
      .internalEvents((event) => event.type === "workspaces.changed", "merge when ready")
      .pipe(
        Stream.runForEach(() =>
          onWorkspaces.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("merge_when_ready resume check failed").pipe(
                Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              ),
            ),
          ),
        ),
        Effect.forkScoped,
      );

    yield* freezes.changes.pipe(
      Stream.runForEach((change) =>
        Effect.gen(function* () {
          for (const thread of yield* store.listThreads) {
            if (
              thread.boundPr?.mergeWhenReady !== undefined &&
              thread.boundPr.repo.toLowerCase() === change.repo.toLowerCase()
            ) {
              yield* check(thread.id);
            }
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("merge_when_ready freeze check failed").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );

    const check: MergeWhenReadyShape["check"] = (threadId) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId).pipe(Effect.option);
        if (Option.isNone(thread)) return;
        yield* stop(threadId);
        yield* evaluate(thread.value, yield* publisher.badgeFor(thread.value));
      });

    const runLocalCheck: MergeWhenReadyShape["runLocalCheck"] = (threadId, options) =>
      Effect.gen(function* () {
        if (localChecks === undefined) return { refused: "Gram's local checks aren't available" };
        const thread = yield* store.getThread(threadId).pipe(Effect.option);
        if (Option.isNone(thread)) return { refused: "the thread wasn't found" };
        const bound = thread.value.boundPr;
        if (bound === undefined)
          return { refused: "this thread has no bound pull request: push, open it and pr_bind it" };
        const cancel = options?.cancel === true;
        if (cancel && bound.mergeWhenReady !== undefined)
          return {
            refused: `merge_when_ready is armed on ${prName(bound)} and would start it again; drop it with enabled: false, which cancels the check too`,
          };
        const { policy } = yield* policyFor(thread.value, bound.repo);
        if (policy !== "solo" && !cancel)
          return {
            refused: `the workspace's merge review policy for ${bound.repo} is ${policy}, and only solo accepts Gram's own check in place of CI`,
          };
        const workspace =
          thread.value.workspaceId === undefined
            ? undefined
            : yield* store
                .getWorkspace(thread.value.workspaceId)
                .pipe(Effect.orElseSucceed(() => undefined));
        if (workspace?.paused !== undefined && !cancel) return { refused: PAUSED_BLOCKER };
        if (!cancel && workspace !== undefined && featurePaused(workspace, thread.value))
          return { refused: `the user paused feature ${thread.value.spawnedBy?.feature}` };
        const cwd = yield* ghDirOf(thread.value);
        const badge = yield* providerPr
          .status(cwd, { repo: bound.repo, number: bound.number }, undefined, { fresh: true })
          .pipe(Effect.orElseSucceed(() => undefined));
        if (badge === undefined || !isBadgeOf(badge, bound))
          return { refused: `GitHub's state of ${prName(bound)} couldn't be read; try again` };
        if (badge.state !== "OPEN")
          return { refused: `${prName(bound)} is ${badge.state.toLowerCase()}` };
        const head = badge.headRefOid;
        const base = currentBaseOf(badge);
        if (head === undefined || base === undefined)
          return { refused: `GitHub didn't give ${prName(bound)}'s head and base commits` };
        const ownership = yield* checkProvenance(
          thread.value,
          bound,
          badge,
          head,
          bound.mergeWhenReady,
        );
        if (ownership !== undefined) {
          const { reason, fix, unblocks } = explainOwnershipBlocker(ownership);
          return {
            refused: `${prName(bound)} isn't this worker's own pull request: ${reason}${unblocks ? `. ${fix.replace(/\.$/, "")}` : ""}`,
          };
        }
        if (cancel) return { cancelled: yield* localChecks.cancel(bound, "its thread asked") };
        const site = yield* checkSiteFor(thread.value, Effect.succeed(cwd));
        const configuration = yield* localChecks.configuration(site, thread.value.projectId);
        if (configuration.config === undefined) return { refused: configuration.reason };
        if (configuration.config.refusal !== undefined)
          return { refused: configuration.config.refusal };
        const before = yield* localChecks.lookup(site, head, base, thread.value.projectId);
        if (options?.start === false) return { check: before, reused: false };
        const requestedAt = yield* Clock.currentTimeMillis;
        const found = yield* localChecks.ensure(site, head, base, {
          projectId: thread.value.projectId,
          pr: bound,
          since: requestedAt,
          ...(verificationAfter.has(baseKey(bound.repo, badge.baseRef))
            ? { after: verificationAfter.get(baseKey(bound.repo, badge.baseRef))! }
            : {}),
          onDone: (done) =>
            Effect.gen(function* () {
              const latest = yield* store.getThread(threadId).pipe(Effect.option);
              const now = Option.isSome(latest) ? latest.value : thread.value;
              yield* runtimes
                .sendNotice(threadId, `local-check:${prName(bound)}`, {
                  text:
                    done.status === "passed"
                      ? localCheckPassedText(bound, done)
                      : done.cancelled !== undefined
                        ? localCheckCancelledText(bound, done)
                        : localCheckFailedText(bound, done),
                })
                .pipe(Effect.ignore);
              if (now.boundPr?.mergeWhenReady !== undefined)
                yield* Effect.suspend(() => check(threadId));
            }),
        });
        if (found === undefined)
          return {
            refused: `Gram couldn't find ${head.slice(0, 7)} and ${base.slice(0, 7)} in the repository, even after fetching them`,
          };
        return { check: found, reused: before?.status === "passed" };
      });

    const resolveFence: MergeWhenReadyShape["resolveFence"] = (caller, input) =>
      Effect.gen(function* () {
        const refuse = fenceRefusal;
        const entry = [...unsettled].find(
          ([, pending]) =>
            samePr(pending.pr, input) &&
            pending.head === input.head &&
            (input.at === undefined || input.at === pending.at),
        );
        if (entry === undefined)
          return yield* refuse(
            "That exact pending merge fence no longer exists; inspect its current state.",
          );
        const [key, pending] = entry;
        const authority = yield* store
          .getThreadWithAuthority(pending.threadId, caller)
          .pipe(Effect.option);
        if (
          !input.userApproved &&
          (Option.isNone(authority) ||
            !userMergeApproverIsOrchestrator(
              caller,
              authority.value.thread,
              authority.value.context,
            ))
        )
          return yield* refuse(
            "Only the user or the owning orchestrator may explicitly resolve this fence.",
          );
        const actor = yield* store
          .getThread(caller)
          .pipe(Effect.mapError(() => refuse("The caller no longer exists.")));
        const owner = Option.isSome(authority) ? authority.value.thread : actor;
        const cwd = yield* ghDirOf(owner);
        const result = yield* baseLocks.withLock(
          key,
          Effect.gen(function* () {
            if (unsettled.get(key) !== pending)
              return yield* refuse("The fence changed during the call; inspect it again.");
            const observed = yield* run(cwd, [
              "pr",
              "view",
              String(pending.pr.number),
              "--repo",
              pending.pr.repo,
              "--json",
              "state,headRefOid",
            ]).pipe(
              Effect.flatMap((out) =>
                Effect.try({
                  try: () =>
                    out.status === 0
                      ? Schema.decodeUnknownSync(observedMerge)(JSON.parse(out.stdout))
                      : undefined,
                  catch: () => undefined,
                }),
              ),
              Effect.orElseSucceed(() => undefined),
            );
            if (
              observed === undefined ||
              (observed.state !== "MERGED" && observed.state !== "CLOSED") ||
              observed.headRefOid === ""
            )
              return yield* refuse(
                "GitHub must confirm that the fenced PR is merged or closed, with its terminal head. OPEN or unreadable cannot resolve it.",
              );
            const branch = key.slice(key.indexOf("\u0000") + 1);
            if (branch === "")
              return yield* refuse(
                "The original base branch is unknown; its state cannot be verified.",
              );
            const freshBase = yield* readBase(cwd, pending.pr.repo, branch);
            if (freshBase === undefined)
              return yield* refuse(
                "GitHub's current base branch cannot be verified; the fence remains.",
              );
            const prior = (movedBases.get(key) ?? []).filter((tip) => tip !== freshBase);
            const moved =
              observed.state === "MERGED" && pending.tip !== undefined && pending.tip !== freshBase
                ? [...prior.filter((tip) => tip !== pending.tip), pending.tip].slice(
                    -MOVED_BASES_KEPT,
                  )
                : prior;
            const cutoff = yield* Clock.currentTimeMillis;
            const record: MergeFence = { key, moved, verifyAfter: cutoff };
            return yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const committed = yield* store.reconcileMergeFence(
                  record,
                  pending,
                  caller,
                  (thread, context) =>
                    input.userApproved ||
                    (thread !== undefined &&
                      userMergeApproverIsOrchestrator(caller, thread, context)),
                );
                if (!committed)
                  return yield* refuse(
                    "The owning authority or pending fence changed; inspect it again.",
                  );
                unsettled.delete(key);
                movedBases.set(key, [...moved]);
                verificationAfter.set(key, cutoff);
                turns.delete(key);
                yield* clearFenceWait(pending);
                yield* tell(
                  owner,
                  pending.pr,
                  `Merge fence resolved explicitly: GitHub reports ${observed.state.toLowerCase()} at ${observed.headRefOid}. ${branch} was freshly read at ${freshBase}. Older local passes are retired; later merges require fresh verification.`,
                  "merge-fence-resolved",
                );
                return {
                  resolved: true as const,
                  terminal: observed.state,
                  observedHead: observed.headRefOid,
                  base: freshBase,
                };
              }),
            );
          }),
        );
        yield* FiberMap.run(
          aftermath,
          `resolved:${key}:${pending.at}`,
          afterMerge(pending.threadId, pending.pr),
        );
        return result;
      });

    const mutate: MergeWhenReadyShape["mutate"] = (threadId, change) =>
      serial(threadId, Effect.andThen(stop(threadId), change)).pipe(
        Effect.ensuring(check(threadId)),
      );

    return MergeWhenReady.of({ check, mutate, runLocalCheck, resolveFence });
  }),
);
