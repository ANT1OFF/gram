import {
  currentBaseOf,
  AppToolError,
  isLocalHost,
  MERGE_AFTER_MAX,
  mergeFreezeText,
  mergeReviewPolicyOf,
  reviewBotsOf,
  samePr,
  type BoundPr,
  type MergeIntent,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import {
  gh,
  gitFailMsg,
  invalidatePrBadges,
  originOwnerRepo,
  prHead,
  Proc,
  repoFromPrUrl,
  type ProcOutput,
} from "@gram/git";
import { randomUUID } from "node:crypto";
import {
  userMergeAuthorizationMatches,
  userMergeApproverIsOrchestrator,
  userMergeDelegationIsLive,
} from "../git/user-merge-authorization.ts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  addExtraPr,
  applyPrEdit,
  bindMainPr,
  editMainPr,
  removeExtraPr,
  dependencyBlocker,
  isBadgeOf,
  rebindBlocker,
} from "../git/extra-prs.ts";
import { ghThreadEnv } from "../embedding/github-relay.ts";
import { ghFolderOf } from "../fs/folders.ts";
import { GitRefresh } from "../git/platform.ts";
import { checkSiteOf } from "../git/check-site.ts";
import { LocalChecks } from "../git/local-checks.ts";
import { MergeFreezes } from "../git/merge-freezes.ts";
import { mergeBlocker, MergeWhenReady, parsePrRef, prName } from "../git/merge-when-ready.ts";
import { soloGateCantPass } from "../git/solo-gate.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { makeMergeFreezeTool } from "./merge-freeze-tool.ts";
import { makeRunMonitorTool } from "./run-monitor-tool.ts";
import { refuseOutOfReach, repoOfIdentity, repoOutOfReach } from "../git/repo-reach.ts";
import {
  withOwnedBranch,
  endedPrText,
  ownershipRefusal,
  workerOwnsPr as ownsPr,
  workerPrOwnership,
  workerPrIdentity,
  withMachines,
} from "../git/worker-pr.ts";
import { WorkerHosts } from "../host/worker-host.ts";
import { MachineBranchPr } from "../git/machine-branch-pr.ts";
import { ThreadPrLookup } from "../git/thread-pr.ts";
import { mergeDelegationStands } from "../orchestration/rules.ts";
import { Orchestration } from "../orchestration/service.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { defineAppTool, failed, OWN_PR_AUDIENCE, refuseOrchestratorPr } from "./definition.ts";
import { resolveMergeFenceTool } from "./resolve-merge-fence.ts";
import { AppToolRegistry } from "./registry.ts";

const REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * How often a waiting merge card reads its PR's badge, to be withdrawn once the PR has merged or
 * closed: an in-memory read of what the badge sweep last saw, which costs no GitHub call.
 */
export const MERGE_CARD_ENDED_POLL = Duration.seconds(15);

interface BindInput {
  readonly repo?: string;
  readonly number?: number;
  readonly monitor?: boolean;
  readonly add?: boolean;
}

interface MergeTarget {
  readonly thread: Thread;
  readonly other: boolean;
  readonly enabled: boolean;
  readonly method: "squash" | "merge" | "rebase";
  readonly number: number;
  readonly repo: string;
  readonly title?: string | undefined;
  readonly head?: string | undefined;
  readonly mergeState?: string | undefined;
  readonly base?: string | undefined;
}

const CLEAN_STATUS = /is in clean status/i;

const refuseOverHold = (tool: string, caller: ThreadId, thread: Thread) => {
  const intent = thread.boundPr?.mergeWhenReady;
  return intent?.heldBy === "orchestrator" && caller === thread.id
    ? Effect.fail(new AppToolError({ tool, message: heldMessage(intent) }))
    : Effect.void;
};

const approvalScopeText = (scope: NonNullable<MergeIntent["approved"]>) =>
  scope.fork
    ? `from a fork${scope.headRepo === undefined ? "" : ` (${scope.headRepo})`}, its head ${scope.head.slice(0, 7)} exactly, into ${scope.baseRef}; a new push to the fork asks again`
    : `from a branch in the repository itself, at ${scope.head.slice(0, 7)} now, into ${scope.baseRef}`;

const heldMessage = (intent: MergeIntent) =>
  `Your orchestrator holds this pull request's merge (${[
    ...(intent.after ?? []).map((pr) => `after ${pr.repo}#${pr.number}`),
    ...(intent.hold === undefined ? [] : [intent.hold]),
  ].join("; ")}); only it can lift the hold.`;

const watchingMergeRefusal = (thread: Thread): string => {
  const pr = thread.boundPr === undefined ? "this pull request" : prName(thread.boundPr);
  return `Watch PR is on for ${pr}: while it watches the review, the user merges. Turn Watch PR off to let Gram merge it, or ask the user to merge it.`;
};

const refuseInBabysit = (thread: Thread) =>
  thread.babysit === undefined
    ? Effect.void
    : Effect.fail(
        new AppToolError({
          tool: "set_auto_merge",
          message: "Auto-merge isn't allowed in babysit mode; the user merges.",
        }),
      );

const reservedRefusal = (pr: { readonly repo: string; readonly number: number }) =>
  `${pr.repo}#${pr.number} is being merged by another thread right now, so it can't become this thread's pull request, and this thread's bindings were left as they were. Check it with pr_status once that merge settles, and bind it again if it is still open.`;

export const PrAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const refreshes = yield* GitRefresh;
    const threadPr = yield* ThreadPrLookup;
    const machineBranchPr = yield* MachineBranchPr;
    const publisher = yield* GitStatePublisher;
    const proc = yield* Proc;
    const machines = Option.getOrUndefined(yield* Effect.serviceOption(WorkerHosts));
    const localChecks = Option.getOrUndefined(yield* Effect.serviceOption(LocalChecks));
    const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
    const mergeWhenReady = Option.getOrUndefined(yield* Effect.serviceOption(MergeWhenReady));
    const freezes = yield* MergeFreezes;
    const refuseWhileFrozen = (
      tool: string,
      thread: Thread,
      repo: string,
      base: string | undefined,
      number: number,
    ) =>
      freezes.holding(repo, base, number, thread.workspaceId).pipe(
        Effect.flatMap((frozen) =>
          frozen === undefined
            ? Effect.void
            : Effect.fail(
                new AppToolError({
                  tool,
                  message: `${mergeFreezeText(frozen)}; Gram doesn't merge onto it until the freeze ends.`,
                }),
              ),
        ),
      );

    const currentPr = (thread: Thread) =>
      isLocalHost(thread.checkout)
        ? threadPr.badge(thread.checkout.path)
        : machineBranchPr.pr(thread);
    const originOf = (thread: Thread) =>
      isLocalHost(thread.checkout)
        ? originOwnerRepo(thread.checkout.path).pipe(Effect.provideService(Proc, proc))
        : machineBranchPr.origin(thread);

    const reviewPolicyFor = (thread: Thread, repo: string) =>
      Effect.gen(function* () {
        const workspace =
          thread.workspaceId === undefined
            ? undefined
            : yield* store
                .getWorkspace(thread.workspaceId)
                .pipe(Effect.orElseSucceed(() => undefined));
        return mergeReviewPolicyOf(
          workspace?.charter,
          repo,
          reviewBotsOf(yield* store.getSettings),
        );
      });
    const requireGitHubAutoPolicy = (thread: Thread, repo: string) =>
      Effect.gen(function* () {
        if ((yield* reviewPolicyFor(thread, repo)) === "solo")
          return yield* new AppToolError({
            tool: "set_auto_merge",
            message:
              "Solo development uses merge_when_ready to enforce current-head CI or a local check, dependencies and holds. GitHub auto-merge alone cannot enforce this policy on an unprotected branch.",
          });
      });

    const workerOwnsPr = (thread: Thread, repo: string, number: number) =>
      ownsPr(thread, repo, number).pipe(
        Effect.provideService(ThreadStore, store),
        Effect.provideService(Proc, proc),
        withMachines(machines),
      );

    const bind = (tool: string, threadId: ThreadId, input: BindInput) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        yield* refuseOrchestratorPr(tool, thread);
        const badge =
          input.number === undefined || input.repo === undefined
            ? yield* currentPr(thread)
            : undefined;
        const number = input.number ?? badge?.number;
        const repo =
          input.repo ??
          thread.boundPr?.repo ??
          (badge === undefined ? undefined : repoFromPrUrl(badge.url));
        if (number === undefined || repo === undefined) {
          return yield* new AppToolError({
            tool,
            message: "No pull request found for this branch; pass repo and number.",
          });
        }
        const refusal =
          !REPO.test(repo) || number <= 0
            ? `invalid pull request ${repo}#${number}`
            : yield* repoOutOfReach(store, thread, repo).pipe(Effect.provideService(Proc, proc));
        if (refusal !== undefined) return yield* new AppToolError({ tool, message: refusal });
        if (input.add === true && thread.boundPr !== undefined) {
          const added = yield* applyPrEdit(runtimes.updateThread, threadId, (t) =>
            t.boundPr === undefined
              ? { refused: "this thread has no main pull request any more; bind without add" }
              : addExtraPr(t, { repo, number }, input.monitor ?? false),
          );
          if (added.refused !== undefined) {
            return yield* new AppToolError({ tool, message: added.refused });
          }
          yield* refreshes.request(added.thread.checkout.path, true);
          return { repo, number, monitor: input.monitor ?? false } satisfies BoundPr;
        }
        let held: string | undefined;
        const updated = yield* runtimes.updateThread(threadId, (t) => {
          const same = t.boundPr !== undefined && samePr(t.boundPr, { repo, number });
          if (!same && t.boundPr?.mergeWhenReady?.heldBy === "orchestrator") {
            held = heldMessage(t.boundPr.mergeWhenReady);
            return t;
          }
          held = rebindBlocker(t, { repo, number }) ?? (same ? undefined : dependencyBlocker(t));
          if (held !== undefined) return t;
          return bindMainPr(t, {
            ...(same ? t.boundPr : { repo, number }),
            monitor: input.monitor ?? t.boundPr?.monitor ?? false,
          });
        });
        if (held !== undefined) return yield* new AppToolError({ tool, message: held });
        if (
          (updated.boundPr === undefined || !samePr(updated.boundPr, { repo, number })) &&
          (yield* reservedElsewhere({ repo, number }, threadId))
        )
          return yield* new AppToolError({ tool, message: reservedRefusal({ repo, number }) });
        yield* refreshes.request(updated.checkout.path, true);
        return updated.boundPr ?? { repo, number, monitor: input.monitor ?? false };
      });

    const prBind = defineAppTool({
      descriptor: {
        name: "pr_bind",
        class: "self",
        description:
          "Follow a pull request from this thread, so its badge and CI state track it; by default the PR for this branch. A thread has one main PR, which a second pr_bind replaces unless merge_when_ready is armed on it: wait for that merge or disable the intent first. add: true follows another PR beside it instead (badge and CI only, up to 8).",
      },
      input: Schema.Struct({
        repo: Schema.optionalKey(Schema.String),
        number: Schema.optionalKey(Schema.Int),
        monitor: Schema.optionalKey(Schema.Boolean),
        add: Schema.optionalKey(Schema.Boolean),
      }),
      audience: OWN_PR_AUDIENCE,
      handle: (threadId, input) =>
        bind("pr_bind", threadId, input).pipe(
          Effect.map((bound) => ({ bound })),
          Effect.mapError(failed("pr_bind")),
        ),
    });

    const prUnbind = defineAppTool({
      descriptor: {
        name: "pr_unbind",
        class: "self",
        description:
          "Stop following this thread's main pull request, or with repo and number one it follows beside it (pr_bind add: true).",
      },
      input: Schema.Struct({
        reason: Schema.optionalKey(Schema.String),
        repo: Schema.optionalKey(Schema.String),
        number: Schema.optionalKey(Schema.Int),
      }),
      audience: OWN_PR_AUDIENCE,
      handle: (threadId, { repo, number }) =>
        Effect.gen(function* () {
          if ((repo === undefined) !== (number === undefined)) {
            return yield* new AppToolError({
              tool: "pr_unbind",
              message:
                "Pass both repo and number to stop following an extra pull request, or neither for the main one.",
            });
          }
          const ref = repo === undefined || number === undefined ? undefined : { repo, number };
          let held: string | undefined;
          let unbound: { readonly repo: string; readonly number: number } | undefined;
          const thread = yield* runtimes.updateThread(threadId, (t) => {
            if (ref !== undefined && !(t.boundPr !== undefined && samePr(t.boundPr, ref))) {
              unbound = ref;
              return removeExtraPr(t, ref);
            }
            const { boundPr, ...rest } = t;
            unbound = boundPr;
            if (boundPr?.mergeWhenReady?.heldBy === "orchestrator") {
              held = heldMessage(boundPr.mergeWhenReady);
              return t;
            }
            held = dependencyBlocker(t);
            return held === undefined ? rest : t;
          });
          if (held !== undefined) {
            return yield* new AppToolError({ tool: "pr_unbind", message: held });
          }
          if (unbound !== undefined) yield* freezes.forget(unbound.repo, unbound.number);
          yield* refreshes.request(thread.checkout.path, true);
          return { unbound: true };
        }).pipe(Effect.mapError(failed("pr_unbind"))),
    });

    const prStatus = defineAppTool({
      descriptor: {
        name: "pr_status",
        class: "read",
        description:
          "A thread's pull request from Gram's cached gh state: state, checks, resolved merge review policy, under solo Gram's own full check of its head merged onto its base (running, passed or failed with why; merge_when_ready or local_check starts it), and whether it's bound and monitored. This thread's unless threadId names another. Prefer this to polling gh.",
      },
      input: Schema.Struct({
        refresh: Schema.optionalKey(Schema.Boolean),
        threadId: Schema.optionalKey(Schema.NonEmptyString),
      }),
      handle: (caller, { refresh = false, threadId = caller }) =>
        Effect.gen(function* () {
          const thread = yield* store.getThread(threadId as ThreadId);
          yield* refuseOrchestratorPr("pr_status", thread);
          const theirs =
            threadId === caller ? undefined : repoOfIdentity(thread.checkout.cloneIdentity);
          yield* refuseOutOfReach("pr_status", store, caller, {
            repos: [thread.boundPr?.repo, theirs],
          });
          if (refresh) yield* refreshes.request(thread.checkout.path, true);
          const badge = yield* currentPr(thread);
          const badgeRepo = badge === undefined ? undefined : repoFromPrUrl(badge.url);
          const repo = thread.boundPr?.repo ?? badgeRepo;
          yield* refuseOutOfReach("pr_status", store, caller, { repos: [repo, badgeRepo] });
          const reviewPolicy =
            repo === undefined ? undefined : yield* reviewPolicyFor(thread, repo);
          const configuration =
            localChecks === undefined
              ? undefined
              : yield* localChecks.configuration(
                  checkSiteOf(thread.checkout, thread.checkout.path),
                  thread.projectId,
                );
          const localCheck =
            reviewPolicy === "solo" &&
            badge?.state === "OPEN" &&
            localChecks !== undefined &&
            configuration?.config?.refusal === undefined
              ? yield* localChecks.lookup(
                  checkSiteOf(thread.checkout, thread.checkout.path),
                  badge.headRefOid,
                  currentBaseOf(badge),
                  thread.projectId,
                )
              : undefined;
          return {
            ...(reviewPolicy === "solo" && configuration?.config?.refusal !== undefined
              ? { localGate: { status: "unavailable", reason: configuration.config.refusal } }
              : reviewPolicy === "solo" &&
                  configuration?.config === undefined &&
                  configuration !== undefined
                ? { localGate: { status: "off", reason: configuration.reason } }
                : {}),
            ...(reviewPolicy === undefined ? {} : { mergeReviewPolicy: reviewPolicy }),
            ...(localCheck === undefined
              ? {}
              : {
                  localCheck: {
                    status: localCheck.status,
                    head: localCheck.head,
                    base: localCheck.base,
                    command: localCheck.command,
                    ...(localCheck.setup === undefined ? {} : { setup: localCheck.setup }),
                    ...(localCheck.timeoutMs === undefined
                      ? {}
                      : { timeoutMs: localCheck.timeoutMs }),
                    startedAt: localCheck.startedAt,
                    ...(localCheck.finishedAt === undefined
                      ? {}
                      : { finishedAt: localCheck.finishedAt }),
                    host: localCheck.host,
                    ...(localCheck.reason === undefined ? {} : { reason: localCheck.reason }),
                    ...(localCheck.failure === undefined ? {} : { failure: localCheck.failure }),
                    ...(localCheck.log === undefined ? {} : { log: localCheck.log }),
                  },
                }),
            ...(thread.boundPr === undefined ? {} : { bound: thread.boundPr }),
            ...(badge === undefined ? {} : { pr: badge }),
          };
        }).pipe(Effect.mapError(failed("pr_status"))),
    });

    const prMonitor = defineAppTool({
      descriptor: {
        name: "pr_monitor",
        class: "self",
        description:
          'Watch CI on this thread\'s pull request. When checks settle, Gram sends one message into this thread ("CI failed on #12: build" or "CI passed on #12"): mid-turn while you work where the agent supports it, otherwise waking you once you\'re idle, a newer one replacing any still waiting. Binds the branch\'s PR if none is bound.',
      },
      input: Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) }),
      audience: OWN_PR_AUDIENCE,
      handle: (threadId, { enabled = true }) =>
        Effect.gen(function* () {
          yield* refuseOrchestratorPr("pr_monitor", yield* store.getThread(threadId));
          const { thread, refused } = yield* applyPrEdit(
            runtimes.updateThread,
            threadId,
            editMainPr((bound) => ({ ...bound, monitor: enabled })),
          );
          if (refused === undefined) return { monitor: enabled, bound: thread.boundPr };
          if (!enabled) return { monitor: false };
          return { monitor: true, bound: yield* bind("pr_monitor", threadId, { monitor: true }) };
        }).pipe(Effect.mapError(failed("pr_monitor"))),
    });

    const setAutoMerge = defineAppTool({
      descriptor: {
        name: "set_auto_merge",
        class: "outward",
        description:
          "Merge a thread's pull request once GitHub allows it, or with enabled: false turn its auto-merge off: this thread's, or threadId's; its bound PR, else its branch's, unless number names another in the same repo. Solo development must use merge_when_ready for its CI and hold gates. A PR that can merge now (CLEAN) merges at once, pinned to the head its badge showed; otherwise GitHub auto-merge is armed. The result's `merged` or `autoMerge` says which. Retry if its PR stays open once clean; branch protection still applies. The user approves every call, except a worker on its own PR, or an orchestrator on its worker's, at `full`: its branch's PR in a workspace project. Unverified ownership at full refuses with repair steps, never a card.",
      },
      input: Schema.Struct({
        enabled: Schema.optionalKey(Schema.Boolean),
        method: Schema.optionalKey(Schema.Literals(["squash", "merge", "rebase"])),
        number: Schema.optionalKey(Schema.Int),
        threadId: Schema.optionalKey(Schema.NonEmptyString),
      }),
      delegatedAtFullAutonomy: (caller, { number }, target: MergeTarget) =>
        Effect.gen(function* () {
          const { thread } = target;
          if (
            thread.id === caller &&
            (thread.boundPr === undefined ||
              (number !== undefined && thread.boundPr.number !== number))
          ) {
            return false;
          }
          if (!(yield* mergeDelegated(caller, thread))) return false;
          return yield* workerOwnsPr(thread, target.repo, target.number);
        }).pipe(Effect.catchCause(() => Effect.succeed(false))),
      decision: (_caller, target: MergeTarget) =>
        target.enabled
          ? {
              action: "pr.merge",
              detail: {
                repo: target.repo,
                number: target.number,
                method: target.method,
                auto: true,
                threadId: target.thread.id,
              },
            }
          : undefined,
      resolve: (caller, { enabled = true, method = "squash", number, threadId = caller }) =>
        Effect.gen(function* () {
          const tool = "set_auto_merge";
          const thread = yield* store
            .getThread(threadId as ThreadId)
            .pipe(Effect.mapError(failed(tool)));
          yield* refuseOrchestratorPr(tool, thread);
          yield* refuseInBabysit(thread);
          yield* refuseOverHold(tool, caller, thread);
          const bound = thread.boundPr;
          const branch =
            number === undefined && bound === undefined ? yield* currentPr(thread) : undefined;
          const target = number ?? bound?.number ?? branch?.number;
          if (target === undefined) {
            return yield* new AppToolError({
              tool,
              message: "No pull request found for this branch; pass number.",
            });
          }
          const state = isLocalHost(thread.checkout)
            ? yield* publisher.stateFor(thread.checkout.path)
            : yield* publisher.stateForThread(thread);
          const repo =
            bound?.number === target
              ? bound.repo
              : ((branch === undefined ? undefined : repoFromPrUrl(branch.url)) ??
                (isLocalHost(thread.checkout) ? state?.origin : undefined) ??
                (yield* originOf(thread)));
          if (repo === undefined) {
            return yield* new AppToolError({
              tool,
              message: `Can't tell which repository #${target} is in; bind it with pr_bind repo and number.`,
            });
          }
          const known = [
            branch,
            yield* publisher.badgeFor(thread),
            state?.pr,
            ...(state?.extraPrs ?? []),
          ];
          const seen = known.find(
            (badge) =>
              badge !== undefined &&
              samePr(
                { repo, number: target },
                { repo: repoFromPrUrl(badge.url) ?? "", number: badge.number },
              ),
          );
          if (enabled) {
            yield* refuseWhileFrozen(tool, thread, repo, seen?.baseRef, target);
            yield* requireGitHubAutoPolicy(thread, repo);
          }
          return {
            thread,
            other: threadId !== caller,
            enabled,
            method,
            number: target,
            repo,
            ...(seen === undefined
              ? {}
              : {
                  title: seen.title,
                  head: seen.headRefOid,
                  mergeState: seen.mergeState,
                  base: seen.baseRef,
                }),
          } satisfies MergeTarget;
        }),
      refuseInsteadOfAsking: (caller, { thread, enabled, number, repo }) =>
        Effect.gen(function* () {
          const ended = yield* endedFromBadges(thread, { repo, number });
          if (ended !== undefined) return ended;
          return yield* refusalForAgent(
            caller,
            thread,
            { repo, number },
            "set_auto_merge",
            enabled ? "merges it" : "turns its auto-merge off",
            false,
          );
        }),
      describe: (_caller, { thread, other, enabled, method, number, repo, title }) => {
        const pr = `${repo}#${number}${title === undefined ? "" : ` “${title}”`}`;
        const on = other ? `, on “${thread.title}”` : "";
        return Effect.succeed(
          enabled
            ? `Merge ${pr} (${method}) once GitHub allows it${on}`
            : `Stop auto-merging ${pr}${on}`,
        );
      },
      handle: (
        caller,
        { thread, other, enabled, method, number, repo, head, mergeState, base },
        call,
      ) =>
        Effect.gen(function* () {
          const tool = "set_auto_merge";
          const cwd = yield* ghFolderOf(thread.checkout);
          const stillAllowed = Effect.gen(function* () {
            const latest = yield* store.getThread(thread.id);
            yield* refuseInBabysit(latest);
            if (enabled) {
              yield* refuseOverHold(tool, caller, latest);
              yield* requireGitHubAutoPolicy(latest, repo);
              if ((yield* freezes.active(repo, undefined)) !== undefined) {
                const fresh = yield* view("baseRefName");
                yield* refuseWhileFrozen(tool, latest, repo, fresh || undefined, number);
              } else {
                yield* refuseWhileFrozen(tool, latest, repo, base, number);
              }
            }
            if (call.carded !== false) return;
            const own =
              thread.id !== caller ||
              (latest.boundPr !== undefined && samePr(latest.boundPr, { repo, number }));
            if (
              !own ||
              !(yield* mergeDelegated(caller, latest)) ||
              !(yield* workerOwnsPr(latest, repo, number))
            ) {
              return yield* new AppToolError({
                tool,
                message:
                  "The pull request or the workspace's autonomy changed during the call; call it again.",
              });
            }
          });
          const run = (args: ReadonlyArray<string>) =>
            gh(cwd, [...args, "--repo", repo], { env: ghThreadEnv(thread.id) }).pipe(
              Effect.provideService(Proc, proc),
            );
          const view = (field: string) =>
            run(["pr", "view", String(number), "--json", field, "--jq", `.${field}`]).pipe(
              Effect.map((out) => (out.status === 0 ? out.stdout.trim() : "")),
            );
          const merge = (pin: string) =>
            run(["pr", "merge", String(number), `--${method}`, "--match-head-commit", pin]);
          const fail = (out: ProcOutput) =>
            new AppToolError({ tool, message: gitFailMsg(out, "gh pr merge failed") });

          const go = freezes.fence(
            repo,
            Effect.gen(function* () {
              yield* stillAllowed;
              let merged = false;
              if (!enabled) {
                const out = yield* run(["pr", "merge", String(number), "--disable-auto"]);
                if (out.status !== 0) return yield* fail(out);
                yield* freezes.forget(repo, number);
              } else if (mergeState === "CLEAN" && head !== undefined) {
                const out = yield* merge(head);
                if (out.status !== 0) return yield* fail(out);
                merged = true;
              } else {
                const armed = yield* run(["pr", "merge", String(number), "--auto", `--${method}`]);
                if (armed.status === 0) {
                  merged = (yield* view("state")) === "MERGED";
                } else if (CLEAN_STATUS.test(armed.stderr)) {
                  const pin = head ?? (yield* view("headRefOid"));
                  if (pin === "") return yield* fail(armed);
                  const out = yield* merge(pin);
                  if (out.status !== 0) return yield* fail(out);
                  merged = true;
                } else {
                  return yield* fail(armed);
                }
              }
              return merged;
            }),
          );
          const merged = yield* mergeWhenReady === undefined
            ? go
            : mergeWhenReady.mutate(thread.id, go);
          invalidatePrBadges();
          yield* refreshes.request(cwd, true, { expectChange: true });
          return {
            ...(other ? { threadId: thread.id } : {}),
            number,
            ...(enabled ? { merged, autoMerge: !merged, method } : { autoMerge: false }),
          };
        }).pipe(Effect.mapError(failed("set_auto_merge"))),
    });

    const runMonitorTool = yield* makeRunMonitorTool;

    const reservedElsewhere = (
      pr: { readonly repo: string; readonly number: number },
      threadId: ThreadId,
    ) =>
      store.listMergeFences.pipe(
        Effect.map((fences) =>
          fences.some(
            (fence) =>
              fence.pending !== undefined &&
              fence.pending.threadId !== threadId &&
              samePr(fence.pending.pr, pr),
          ),
        ),
      );

    const mergeDelegated = (caller: ThreadId, thread: Thread) =>
      Effect.gen(function* () {
        if (orchestration === undefined) return false;
        if (thread.id !== caller) return yield* orchestration.fullAutonomyAllows(caller, thread.id);
        return yield* orchestration.workerMergesOwn(caller);
      }).pipe(Effect.catchCause(() => Effect.succeed(false)));

    const endedState = (thread: Thread, pr: { readonly repo: string; readonly number: number }) =>
      Effect.gen(function* () {
        const badges = [
          yield* publisher.badgeFor(thread),
          ...(yield* publisher.extraBadgesFor(thread)),
        ];
        const badge = badges.find((each) => each !== undefined && isBadgeOf(each, pr));
        return badge?.state === "MERGED"
          ? ("merged" as const)
          : badge?.state === "CLOSED"
            ? ("closed" as const)
            : undefined;
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined)));

    const endedFromBadges = (
      thread: Thread,
      pr: { readonly repo: string; readonly number: number },
    ) =>
      endedState(thread, pr).pipe(
        Effect.map((state) =>
          state === undefined ? undefined : endedPrText(pr.repo, pr.number, state),
        ),
      );

    const mergeCardEnded = (
      threadId: ThreadId,
      pr: { readonly repo: string; readonly number: number },
    ) =>
      Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep(MERGE_CARD_ENDED_POLL);
          const latest = yield* store
            .getThread(threadId)
            .pipe(Effect.orElseSucceed(() => undefined));
          const state = latest === undefined ? undefined : yield* endedState(latest, pr);
          if (state !== undefined)
            return `${prName(pr)} ${state} while the user was being asked, so there is nothing to merge: the card was withdrawn. Check it with pr_status.`;
        }
      });

    const refusalForAgent = (
      caller: ThreadId,
      thread: Thread,
      pr: { readonly repo: string; readonly number: number },
      tool: string,
      action: string,
      merge: boolean,
    ) =>
      Effect.gen(function* () {
        if (merge) {
          const ended = yield* endedFromBadges(thread, pr);
          if (ended !== undefined) return ended;
        }
        if (!(yield* mergeDelegated(caller, thread))) return undefined;
        return yield* ownershipRefusal(thread, pr.repo, pr.number, {
          audience: caller === thread.id ? "worker" : "orchestrator",
          tool,
          action,
        }).pipe(
          Effect.provideService(ThreadStore, store),
          Effect.provideService(Proc, proc),
          withMachines(machines),
        );
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined)));

    const MERGE = "merge_when_ready";
    const approvalScope = (
      thread: Thread,
      pr: { readonly repo: string; readonly number: number },
    ) =>
      Effect.gen(function* () {
        const cwd = yield* ghFolderOf(thread.checkout);
        const head = yield* prHead(cwd, pr.number, pr.repo).pipe(
          Effect.provideService(Proc, proc),
          Effect.catchCause(() => Effect.succeed(undefined)),
        );
        if (
          head === undefined ||
          head.headRefOid === undefined ||
          head.baseRef === undefined ||
          head.repo.toLowerCase() !== pr.repo.toLowerCase()
        )
          return undefined;
        return {
          head: head.headRefOid,
          baseRef: head.baseRef,
          fork: head.fork,
          ...(head.headRepo === undefined ? {} : { headRepo: head.headRepo }),
        } satisfies NonNullable<MergeIntent["approved"]>;
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined)));

    const mergeWhenReadyTool = defineAppTool({
      descriptor: {
        name: MERGE,
        class: "outward",
        description:
          "Merge a pull request once it is ready, then end your turn: Gram squash-merges it (or `method`), pinned with --match-head-commit to the head it checked, once the workspace's merge review policy is satisfied, required checks are green and GitHub would merge it. Defaults to this thread's bound PR or its branch's new PR; threadId targets your worker. `pr` is a number in its checkout's repo or owner/repo#N (or URL), stacked PRs included; arming binds it unless another PR already has an intent. `after` lists PRs that must merge first, such as a release PR. `hold` keeps it waiting, with why, until `release: true` or `hold: null` (or an empty hold); `holdWaitsOn` says on whom: `person` (default; the user or a reviewer) or `agent` (a review bot's re-review, another worker's change). What an orchestrator holds, its worker can't lift. enabled: false drops the intent. The thread is told when it merges, or why GitHub refused. The user approves the call, except a worker on its own PR, or an orchestrator on its worker's, in a workspace whose autonomy is `full`: an open, non-fork PR from a branch observed in a worktree the worker holds in a workspace project (the one Gram gave it, not one it made itself). At full, an orchestrator may maintain or release an identical intent carrying its explicit user approval; a change of target, method or scope, an approval without that provenance, and a worker's call on an orchestrator-held intent still ask. There the autonomy is asked again before merging. At `full`, unverified ownership refuses to the agent with repair steps, never a user card; fix it and re-arm. enabled: false never asks.",
      },
      input: Schema.Struct({
        enabled: Schema.optionalKey(Schema.Boolean),
        method: Schema.optionalKey(Schema.Literals(["squash", "merge", "rebase"])),
        after: Schema.optionalKey(
          Schema.Array(Schema.String).check(Schema.isMaxLength(MERGE_AFTER_MAX)),
        ),
        hold: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
        holdWaitsOn: Schema.optionalKey(Schema.Literals(["person", "agent"])),
        release: Schema.optionalKey(Schema.Boolean),
        threadId: Schema.optionalKey(Schema.NonEmptyString),
        pr: Schema.optionalKey(
          Schema.Union([Schema.Int.check(Schema.isGreaterThan(0)), Schema.NonEmptyString]),
        ),
      }),
      resolve: (caller, rawInput) =>
        Effect.gen(function* () {
          const clearHold =
            rawInput.hold === null ||
            (typeof rawInput.hold === "string" && rawInput.hold.trim() === "");
          const { hold: rawHold, ...restInput } = rawInput;
          const input = {
            ...restInput,
            ...(typeof rawHold === "string" && !clearHold ? { hold: rawHold } : {}),
            clearHold,
          };
          const thread = yield* store
            .getThread((input.threadId ?? caller) as ThreadId)
            .pipe(Effect.mapError(failed(MERGE)));
          yield* refuseOrchestratorPr(MERGE, thread);
          if (thread.babysit?.phase === "watching") {
            return yield* new AppToolError({ tool: MERGE, message: watchingMergeRefusal(thread) });
          }
          const after = (input.after ?? []).map((text) => ({ text, ref: parsePrRef(text) }));
          const bad = after.find((entry) => entry.ref === undefined);
          if (bad !== undefined) {
            return yield* new AppToolError({
              tool: MERGE,
              message: `"${bad.text}" isn't a pull request; write owner/repo#N or its URL.`,
            });
          }
          const named = typeof input.pr === "string" ? parsePrRef(input.pr) : undefined;
          if (typeof input.pr === "string" && named === undefined) {
            return yield* new AppToolError({
              tool: MERGE,
              message: `"${input.pr}" isn't a pull request; write owner/repo#N or its URL.`,
            });
          }
          const repos = [named?.repo, ...after.map((entry) => entry.ref?.repo)];
          yield* refuseOutOfReach(MERGE, store, thread.id, { repos }).pipe(
            Effect.provideService(Proc, proc),
          );
          const branch =
            input.pr === undefined && thread.boundPr === undefined
              ? yield* currentPr(thread)
              : undefined;
          const repo =
            named?.repo ??
            (typeof input.pr === "number"
              ? yield* originOf(thread)
              : (thread.boundPr?.repo ??
                (branch === undefined ? undefined : repoFromPrUrl(branch.url))));
          const number =
            named?.number ??
            (typeof input.pr === "number" ? input.pr : (thread.boundPr?.number ?? branch?.number));
          if (repo === undefined || number === undefined) {
            return yield* new AppToolError({
              tool: MERGE,
              message:
                "No pull request is bound or open for this branch; open one, or bind it with pr_bind.",
            });
          }
          if (input.enabled === false) yield* refuseOverHold(MERGE, caller, thread);
          return {
            ...input,
            method:
              input.method ??
              (thread.boundPr !== undefined && samePr(thread.boundPr, { repo, number })
                ? thread.boundPr.mergeWhenReady?.method
                : undefined) ??
              "squash",
            thread,
            pr: { repo, number },
            afterRefs: after.flatMap((entry) => (entry.ref === undefined ? [] : [entry.ref])),
            scope:
              input.enabled === false ? undefined : yield* approvalScope(thread, { repo, number }),
            reuseApproval:
              input.enabled !== false &&
              input.after === undefined &&
              input.hold === undefined &&
              input.holdWaitsOn === undefined &&
              userMergeAuthorizationMatches(
                caller,
                thread,
                { repo, number },
                input.method ?? thread.boundPr?.mergeWhenReady?.method ?? "squash",
              )
                ? thread.boundPr!.mergeWhenReady
                : undefined,
          };
        }),
      decision: (_caller, { enabled = true, pr, method, thread, scope }) =>
        enabled
          ? {
              action: "pr.merge",
              detail: {
                repo: pr.repo,
                number: pr.number,
                method,
                threadId: thread.id,
                ...(scope === undefined
                  ? {}
                  : {
                      head: scope.head,
                      base: scope.baseRef,
                      fromFork: scope.fork,
                      ...(scope.headRepo === undefined ? {} : { headRepo: scope.headRepo }),
                    }),
              },
            }
          : undefined,
      delegatedAtFullAutonomy: (caller, _input, { thread, pr, reuseApproval, enabled = true }) =>
        Effect.gen(function* () {
          if (!enabled)
            return (
              caller === thread.id ||
              (orchestration !== undefined &&
                (yield* orchestration.coordinationAllows(caller, thread.id)))
            );
          if (caller === thread.id && thread.boundPr?.mergeWhenReady?.heldBy === "orchestrator")
            return false;
          if (!(yield* mergeDelegated(caller, thread))) return false;
          if (reuseApproval !== undefined) {
            const context = {
              caller: yield* store.getThread(caller),
              workspace: yield* store.getWorkspace(thread.workspaceId!),
              settings: yield* store.getSettings,
            };
            return (
              userMergeDelegationIsLive(caller, thread, context) &&
              (yield* workerPrIdentity(thread, pr.repo, pr.number).pipe(
                Effect.provideService(ThreadStore, store),
                Effect.provideService(Proc, proc),
                withMachines(machines),
              ))
            );
          }
          return yield* workerOwnsPr(thread, pr.repo, pr.number);
        }).pipe(Effect.catchCause(() => Effect.succeed(false))),
      describe: (
        caller,
        { thread, pr, enabled = true, method, afterRefs, hold, clearHold, scope },
      ) =>
        Effect.gen(function* () {
          if (!enabled) return `Stop merging ${prName(pr)} when it is ready`;
          const policy = yield* reviewPolicyFor(thread, pr.repo);
          const condition =
            policy === "solo"
              ? `fresh CI passes, or Gram's own full check of it merged onto its base passes${scope?.fork === true ? " (which runs the fork's code at that head on this machine)" : ""}, and GitHub allows it`
              : "it is approved on its head, green and clean";
          return `Merge ${prName(pr)} (${method ?? thread.boundPr?.mergeWhenReady?.method ?? "squash"})${scope === undefined ? "" : ` ${approvalScopeText(scope)},`} once ${condition}${afterRefs.length === 0 ? "" : `, after ${afterRefs.map(prName).join(", ")}`}${clearHold ? ", no hold" : hold === undefined ? "" : `, held: ${hold}`}${thread.id === caller ? "" : `, on “${thread.title}”`}`;
        }),
      refuseInsteadOfAsking: (caller, { thread, pr, enabled = true }) =>
        !enabled
          ? Effect.succeed(undefined)
          : refusalForAgent(caller, thread, pr, MERGE, "merges it once its checks pass", true),
      sharedCard: (
        caller,
        {
          thread,
          pr,
          enabled = true,
          method,
          afterRefs,
          hold,
          holdWaitsOn,
          release,
          clearHold,
          scope,
        },
      ) =>
        Effect.succeed({
          key: JSON.stringify([
            pr.repo.toLowerCase(),
            pr.number,
            scope?.baseRef ?? null,
            scope?.fork === true ? scope.head : null,
            thread.id,
            caller,
            enabled,
            method,
            afterRefs.map((ref) => [ref.repo.toLowerCase(), ref.number]),
            hold ?? null,
            holdWaitsOn ?? null,
            release === true,
            clearHold,
          ]),
          moot: mergeCardEnded(thread.id, pr),
        }),
      handle: (
        caller,
        {
          thread,
          pr,
          enabled = true,
          method,
          afterRefs,
          hold,
          holdWaitsOn,
          release,
          clearHold,
          reuseApproval,
          scope,
        },
        call,
      ) =>
        Effect.gen(function* () {
          const latest = yield* store.getThread(thread.id);
          if (latest.babysit?.phase === "watching") {
            return yield* new AppToolError({ tool: MERGE, message: watchingMergeRefusal(latest) });
          }
          if (!enabled) yield* refuseOverHold(MERGE, caller, latest);
          const byOrchestrator = thread.id !== caller;
          const reusing = call.carded === false && reuseApproval !== undefined;
          const allowedBy = call.carded === false && !reusing ? "autonomy" : "user";
          const reuseWorkspace =
            reusing && latest.workspaceId !== undefined
              ? yield* store.getWorkspace(latest.workspaceId)
              : undefined;
          if (
            reusing &&
            !(yield* workerPrIdentity(latest, pr.repo, pr.number).pipe(
              Effect.provideService(ThreadStore, store),
              Effect.provideService(Proc, proc),
              withMachines(machines),
            ))
          ) {
            return yield* new AppToolError({
              tool: MERGE,
              message: "The approved pull request identity changed during the call; call it again.",
            });
          }
          const approved =
            allowedBy !== "user" || !enabled
              ? undefined
              : call.carded === true
                ? yield* approvalScope(latest, pr)
                : scope;
          if (allowedBy === "user" && enabled) {
            if (approved === undefined || scope === undefined)
              return yield* new AppToolError({
                tool: MERGE,
                message: `GitHub's head and base of ${prName(pr)} couldn't be read, so Gram can't record what the approval covers; call it again.`,
              });
            if (
              approved.baseRef !== scope.baseRef ||
              approved.fork !== scope.fork ||
              (approved.fork && approved.head !== scope.head)
            )
              return yield* new AppToolError({
                tool: MERGE,
                message: `${prName(pr)} changed while the user was asked (now ${approvalScopeText(approved)}), so the approval doesn't cover it; call it again.`,
              });
          }
          const approvedScope = allowedBy === "user" && enabled ? scope : undefined;
          const scopeProjects =
            allowedBy === "autonomy" && enabled && latest.workspaceId !== undefined
              ? JSON.stringify(
                  (yield* store
                    .getWorkspace(latest.workspaceId)
                    .pipe(Effect.orElseSucceed(() => undefined)))?.workspace.projectIds,
                )
              : undefined;
          const ownership =
            allowedBy === "autonomy" && enabled
              ? yield* workerPrOwnership(latest, pr.repo, pr.number).pipe(
                  Effect.provideService(ThreadStore, store),
                  Effect.provideService(Proc, proc),
                  withMachines(machines),
                )
              : undefined;
          const stillWaived =
            !enabled ||
            allowedBy !== "autonomy" ||
            ((thread.id !== caller || latest.boundPr?.mergeWhenReady?.heldBy !== "orchestrator") &&
              (yield* mergeDelegated(caller, latest)) &&
              typeof ownership === "object");
          if (!stillWaived) {
            return yield* new AppToolError({
              tool: MERGE,
              message:
                "The pull request or the workspace's autonomy changed during the call; call it again.",
            });
          }
          const now = yield* Clock.currentTimeMillis;
          let refused: string | undefined;
          const write = runtimes.updateThread(
            thread.id,
            (t, context) => {
              if (
                reusing &&
                (!userMergeAuthorizationMatches(caller, t, pr, method ?? reuseApproval.method) ||
                  !userMergeDelegationIsLive(caller, t, context) ||
                  JSON.stringify(context?.workspace?.workspace.projectIds) !==
                    JSON.stringify(reuseWorkspace?.workspace.projectIds) ||
                  t.boundPr?.mergeWhenReady?.userAuthorization?.id !==
                    reuseApproval.userAuthorization?.id ||
                  JSON.stringify(t.boundPr?.mergeWhenReady) !== JSON.stringify(reuseApproval) ||
                  JSON.stringify(t.checkout) !== JSON.stringify(latest.checkout) ||
                  JSON.stringify(t.extraCheckouts) !== JSON.stringify(latest.extraCheckouts))
              ) {
                refused =
                  "The approved intent or the workspace's delegation changed during the call; call it again.";
                return t;
              }
              if (t.parked || t.babysit?.phase === "watching") {
                refused =
                  "This thread is parked or watching its PR; call it again after that changes.";
                return t;
              }
              if (allowedBy === "autonomy" && context?.prClaimedByOther === true) {
                refused =
                  "Another thread bound this pull request between the check and this write, so it is that thread's to merge now; call again if it should still be yours.";
                return t;
              }
              if (
                allowedBy === "autonomy" &&
                enabled &&
                (!mergeDelegationStands({
                  callerId: caller,
                  caller: context?.caller,
                  target: t,
                  state: context?.workspace,
                }) ||
                  JSON.stringify(context?.workspace?.workspace.projectIds) !== scopeProjects ||
                  JSON.stringify(t.checkout) !== JSON.stringify(latest.checkout) ||
                  JSON.stringify(t.extraCheckouts) !== JSON.stringify(latest.extraCheckouts) ||
                  (caller === thread.id && t.boundPr?.mergeWhenReady?.heldBy === "orchestrator"))
              ) {
                refused =
                  "The workspace's autonomy, the worker's delegation or its scope changed during the call; call it again.";
                return t;
              }
              refused =
                rebindBlocker(t, pr) ??
                (!byOrchestrator && t.boundPr !== undefined && !samePr(t.boundPr, pr)
                  ? dependencyBlocker(t)
                  : undefined);
              if (refused !== undefined) return t;
              const bound: BoundPr =
                t.boundPr !== undefined && samePr(t.boundPr, pr)
                  ? t.boundPr
                  : { repo: pr.repo, number: pr.number, monitor: false };
              const { mergeWhenReady: current, mergeWaiting: _, ...rest } = bound;
              if (!enabled && current?.heldBy === "orchestrator" && !byOrchestrator) {
                refused = heldMessage(current);
                return t;
              }
              if (!enabled) return current === undefined ? t : bindMainPr(t, rest);
              const locked = !byOrchestrator && current?.heldBy === "orchestrator";
              if (locked && (release === true || clearHold)) {
                refused = "Your orchestrator holds this merge; only it can lift the hold.";
                return t;
              }
              const keptAfter = locked || release !== true ? (current?.after ?? []) : [];
              const mergedAfter = [
                ...keptAfter,
                ...afterRefs.filter(
                  (ref, i) =>
                    !keptAfter.some((kept) => samePr(kept, ref)) &&
                    afterRefs.findIndex((other) => samePr(other, ref)) === i,
                ),
              ];
              if (mergedAfter.length > MERGE_AFTER_MAX) {
                refused = `A merge waits on ${MERGE_AFTER_MAX} pull requests at most.`;
                return t;
              }
              const nextHold = locked
                ? (current?.hold ?? hold)
                : (hold ?? (release === true || clearHold ? undefined : current?.hold));
              const nextHoldOn =
                nextHold === undefined
                  ? undefined
                  : locked
                    ? current?.holdWaitsOn
                    : hold === undefined
                      ? (holdWaitsOn ?? current?.holdWaitsOn)
                      : holdWaitsOn;
              const holding = mergedAfter.length > 0 || nextHold !== undefined;
              const intent: MergeIntent = {
                method: method ?? current?.method ?? "squash",
                ...(mergedAfter.length === 0 ? {} : { after: mergedAfter }),
                ...(nextHold === undefined ? {} : { hold: nextHold }),
                ...(nextHoldOn === "agent" ? { holdWaitsOn: nextHoldOn } : {}),
                ...(!holding
                  ? {}
                  : {
                      heldBy:
                        locked || byOrchestrator ? ("orchestrator" as const) : ("thread" as const),
                    }),
                allowedBy,
                ...(approvedScope === undefined ? {} : { approved: approvedScope }),
                ...(reusing
                  ? {
                      userAuthorization: {
                        ...reuseApproval.userAuthorization!,
                        reused: true as const,
                      },
                    }
                  : call.carded === true &&
                      t.workspaceId !== undefined &&
                      userMergeApproverIsOrchestrator(caller, t, context)
                    ? {
                        userAuthorization: {
                          id: randomUUID(),
                          callerId: caller,
                          threadId: t.id,
                          workspaceId: t.workspaceId,
                          repo: pr.repo,
                          number: pr.number,
                          method: method ?? current?.method ?? "squash",
                        },
                      }
                    : {}),
                setAt: now,
              };
              const owned =
                typeof ownership === "object" ? withOwnedBranch(t, ownership, ownership.branch) : t;
              return bindMainPr(owned, { ...rest, mergeWhenReady: intent });
            },
            reusing || (call.carded === true && byOrchestrator) || allowedBy === "autonomy"
              ? caller
              : undefined,
            allowedBy === "autonomy" && enabled ? { pr } : undefined,
          );
          const updated = yield* mergeWhenReady === undefined
            ? write
            : mergeWhenReady.mutate(thread.id, write);
          if (refused !== undefined)
            return yield* new AppToolError({ tool: MERGE, message: refused });
          if (
            enabled &&
            (updated.boundPr === undefined || !samePr(updated.boundPr, pr)) &&
            (yield* reservedElsewhere(pr, thread.id))
          )
            return yield* new AppToolError({ tool: MERGE, message: reservedRefusal(pr) });
          yield* refreshes.request(updated.checkout.path, true);
          const intent = updated.boundPr?.mergeWhenReady;
          if (intent?.hold !== undefined) yield* freezes.forget(pr.repo, pr.number);
          if (intent === undefined) return { pr: prName(pr), mergeWhenReady: false };
          const configuration =
            localChecks === undefined
              ? undefined
              : yield* localChecks.configuration(
                  checkSiteOf(updated.checkout, updated.checkout.path),
                  updated.projectId,
                );
          const localGate =
            (yield* reviewPolicyFor(updated, pr.repo)) === "solo" &&
            configuration !== undefined &&
            configuration.config === undefined
              ? { status: "off", reason: configuration.reason }
              : undefined;
          const badge = yield* publisher.badgeFor(updated);
          const gateWarning =
            localGate === undefined || badge === undefined || !isBadgeOf(badge, pr)
              ? undefined
              : soloGateCantPass(badge, localGate.reason, configuration?.declaredCiOnly);
          if (localGate !== undefined && updated.workspaceId !== undefined)
            yield* store.appendOrchestrationEvent(updated.workspaceId, {
              at: yield* Clock.currentTimeMillis,
              kind: "localGateOff",
              data: {
                threadId: updated.id,
                pr: prName(pr),
                localGate,
                ...(gateWarning === undefined ? {} : { gateWarning }),
              },
            });
          const waiting =
            badge === undefined
              ? "its state isn't known yet"
              : mergeBlocker(
                  intent,
                  badge,
                  yield* reviewPolicyFor(updated, pr.repo),
                  reviewBotsOf(yield* store.getSettings),
                  undefined,
                  configuration?.declaredCiOnly,
                );
          return {
            ...(byOrchestrator ? { threadId: thread.id } : {}),
            pr: prName(pr),
            mergeWhenReady: true,
            ...(localGate === undefined ? {} : { localGate }),
            ...(gateWarning === undefined ? {} : { gateWarning }),
            method: intent.method,
            ...(intent.after === undefined ? {} : { after: intent.after.map(prName) }),
            ...(intent.hold === undefined
              ? release === true || clearHold
                ? { hold: null, note: "no hold" }
                : {}
              : { hold: intent.hold }),
            ...(intent.holdWaitsOn === undefined ? {} : { holdWaitsOn: intent.holdWaitsOn }),
            ...(waiting === undefined ? {} : { waiting }),
          };
        }).pipe(Effect.mapError(failed(MERGE))),
    });

    const LOCAL_CHECK = "local_check";
    const localCheckTool = defineAppTool({
      descriptor: {
        name: LOCAL_CHECK,
        class: "outward",
        description:
          "Under the solo merge review policy, have Gram run its own full check of your bound PR now, ahead of merge_when_ready: the head GitHub has, merged onto its base's current tip, in a clean worktree on this machine. It runs the PR's code outside your sandbox, so the user approves the call, except on your own PR (the one your worktree's branch opened) in a workspace whose autonomy is `full`. A pass recorded for that exact head, base and check is reused, and merge_when_ready accepts it in place of CI; a failure is run again unless `rerun: false`, which only reports the record. You are told how it ends, and why it failed. A push, a moved base or a changed command, setup or timeout needs a new check. With no configured command the local gate is OFF; CI and GitHub rules apply. Self-reported checks never count. Unverified ownership at full refuses with repair steps, never a card.",
      },
      input: Schema.Struct({ rerun: Schema.optionalKey(Schema.Boolean) }),
      audience: OWN_PR_AUDIENCE,
      delegatedAtFullAutonomy: (caller) =>
        Effect.gen(function* () {
          const thread = yield* store.getThread(caller);
          const bound = thread.boundPr;
          if (bound === undefined || !(yield* mergeDelegated(caller, thread))) return false;
          return yield* workerOwnsPr(thread, bound.repo, bound.number);
        }).pipe(Effect.catchCause(() => Effect.succeed(false))),
      refuseInsteadOfAsking: (caller) =>
        Effect.gen(function* () {
          const thread = yield* store.getThread(caller);
          const bound = thread.boundPr;
          if (bound === undefined) return undefined;
          return yield* refusalForAgent(caller, thread, bound, LOCAL_CHECK, "runs it", false);
        }).pipe(Effect.orElseSucceed(() => undefined)),
      describe: (caller) =>
        store.getThread(caller).pipe(
          Effect.map((thread) =>
            thread.boundPr === undefined
              ? "Run the project's configured local check of this thread's pull request on this machine"
              : `Run the project's configured local check of ${prName(thread.boundPr)} (its head merged onto its base) on this machine`,
          ),
          Effect.orElseSucceed(
            () => "Run the project's configured local check of a pull request on this machine",
          ),
        ),
      handle: (caller, { rerun = true }) =>
        Effect.gen(function* () {
          const thread = yield* store.getThread(caller);
          yield* refuseOrchestratorPr(LOCAL_CHECK, thread);
          if (mergeWhenReady === undefined)
            return yield* new AppToolError({
              tool: LOCAL_CHECK,
              message: "Gram's local checks aren't available here.",
            });
          const result = yield* mergeWhenReady.runLocalCheck(thread.id, { start: rerun });
          if ("refused" in result)
            return yield* new AppToolError({
              tool: LOCAL_CHECK,
              message: `No local check: ${result.refused}.`,
            });
          if (result.check === undefined)
            return {
              status: "none",
              next: "Gram has no check of this head on this base: call local_check to run one.",
            };
          const { check, reused } = result;
          return {
            status: check.status,
            reused,
            head: check.head,
            base: check.base,
            command: check.command,
            ...(check.setup === undefined ? {} : { setup: check.setup }),
            ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }),
            ...(check.reason === undefined ? {} : { reason: check.reason }),
            ...(check.failure === undefined ? {} : { failure: check.failure }),
            ...(check.log === undefined ? {} : { log: check.log }),
            next:
              check.status === "running"
                ? "Gram tells you when it ends; end your turn rather than wait."
                : check.status === "passed"
                  ? "merge_when_ready uses this pass while the head and base stay."
                  : "It failed for this head and base: see reason, then push a fix or call local_check again.",
          };
        }).pipe(Effect.mapError(failed(LOCAL_CHECK))),
    });

    const mergeFreezeTool = yield* makeMergeFreezeTool;

    yield* registry.register([
      mergeFreezeTool,
      resolveMergeFenceTool(store, mergeWhenReady),
      prBind,
      prUnbind,
      prStatus,
      prMonitor,
      setAutoMerge,
      mergeWhenReadyTool,
      runMonitorTool,
      localCheckTool,
    ]);
  }),
);
