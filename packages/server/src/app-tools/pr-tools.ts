import {
  AppToolError,
  MERGE_AFTER_MAX,
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
  rebindBlocker,
} from "../git/extra-prs.ts";
import { GitRefresh } from "../git/platform.ts";
import { LocalChecks } from "../git/local-checks.ts";
import { mergeBlocker, MergeWhenReady, parsePrRef, prName } from "../git/merge-when-ready.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { parseRunRef, RunMonitor } from "../git/run-monitor.ts";
import {
  withOwnedBranch,
  workerOwnsPr as ownsPr,
  workerPrOwnership,
  workerPrIdentity,
} from "../git/worker-pr.ts";
import { ThreadPrLookup } from "../git/thread-pr.ts";
import { Orchestration } from "../orchestration/service.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { defineAppTool, failed, OWN_PR_AUDIENCE, refuseOrchestratorPr } from "./definition.ts";
import { AppToolRegistry } from "./registry.ts";

const REPO = /^[\w.-]+\/[\w.-]+$/;

interface BindInput {
  readonly repo?: string;
  readonly number?: number;
  readonly monitor?: boolean;
  /** Follow the PR beside the thread's main one instead of replacing it. */
  readonly add?: boolean;
}

/** The pull request a `set_auto_merge` call acts on, resolved before its card. */
interface MergeTarget {
  readonly thread: Thread;
  /** The call names another thread than the caller. */
  readonly other: boolean;
  readonly enabled: boolean;
  readonly method: "squash" | "merge" | "rebase";
  readonly number: number;
  /** `owner/repo`, given to gh as `--repo`. */
  readonly repo: string;
  /** From a badge already fetched; absent when none is this PR's. */
  readonly title?: string | undefined;
  /** The head that badge showed, which a direct merge is pinned to. */
  readonly head?: string | undefined;
  /** That badge's `mergeStateStatus`. */
  readonly mergeState?: string | undefined;
}

/** GitHub refusing to arm auto-merge on a PR that can merge right now. */
const CLEAN_STATUS = /is in clean status/i;

/**
 * A merge `merge_when_ready` holds (`after` or `hold`) is refused to the thread itself by every other
 * way of merging or of dropping the intent, when its orchestrator set the hold: release order is the
 * orchestrator's to keep.
 */
const refuseOverHold = (tool: string, caller: ThreadId, thread: Thread) => {
  const intent = thread.boundPr?.mergeWhenReady;
  return intent?.heldBy === "orchestrator" && caller === thread.id
    ? Effect.fail(new AppToolError({ tool, message: heldMessage(intent) }))
    : Effect.void;
};

/** Why a worker can't move past the merge its orchestrator holds. */
const heldMessage = (intent: MergeIntent) =>
  `Your orchestrator holds this pull request's merge (${[
    ...(intent.after ?? []).map((pr) => `after ${pr.repo}#${pr.number}`),
    ...(intent.hold === undefined ? [] : [intent.hold]),
  ].join("; ")}); only it can lift the hold.`;

/** Auto-merge is refused on a thread in babysit mode, where the user merges. */
const refuseInBabysit = (thread: Thread) =>
  thread.babysit === undefined
    ? Effect.void
    : Effect.fail(
        new AppToolError({
          tool: "set_auto_merge",
          message: "Auto-merge isn't allowed in babysit mode; the user merges.",
        }),
      );

/**
 * The git-backed app tools: PR binding and status over the batched `gh` state,
 * the CI monitor, and auto-merge. Registered from above the state publisher, which they read.
 */
export const PrAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const refreshes = yield* GitRefresh;
    const threadPr = yield* ThreadPrLookup;
    const publisher = yield* GitStatePublisher;
    const proc = yield* Proc;
    const localChecks = Option.getOrUndefined(yield* Effect.serviceOption(LocalChecks));
    // Absent in layers without orchestration, where no outward call is ever delegated.
    const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
    const runMonitor = Option.getOrUndefined(yield* Effect.serviceOption(RunMonitor));
    const mergeWhenReady = Option.getOrUndefined(yield* Effect.serviceOption(MergeWhenReady));

    const currentPr = (thread: Thread) => threadPr.badge(thread.checkout.path);

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
        if (!REPO.test(repo) || number <= 0) {
          return yield* new AppToolError({
            tool,
            message: `invalid pull request ${repo}#${number}`,
          });
        }
        if (input.add === true && thread.boundPr !== undefined) {
          const added = yield* applyPrEdit(runtimes.updateThread, threadId, (t) =>
            // Without a main PR by the time this runs, there is nothing to follow it beside.
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
        // The monitor default comes from the row being written, not from the read above. Binding
        // the same PR again keeps what is on its binding, a merge intent included; one its
        // orchestrator holds can't be bound away.
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
        yield* refreshes.request(updated.checkout.path, true);
        return updated.boundPr ?? { repo, number, monitor: input.monitor ?? false };
      });

    const prBind = defineAppTool({
      descriptor: {
        name: "pr_bind",
        class: "self",
        description:
          "Follow a pull request from this thread, so its badge and CI state track it. Defaults to the PR for this branch. A thread has one main PR, which a second pr_bind replaces unless merge_when_ready is armed on it; wait for that merge or explicitly disable the intent first. Pass add: true to follow another PR beside it instead (badge and CI watching only, up to 8).",
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
          // Half a reference must not fall through to the main PR: the caller meant an extra one.
          if ((repo === undefined) !== (number === undefined)) {
            return yield* new AppToolError({
              tool: "pr_unbind",
              message:
                "Pass both repo and number to stop following an extra pull request, or neither for the main one.",
            });
          }
          const ref = repo === undefined || number === undefined ? undefined : { repo, number };
          let held: string | undefined;
          const thread = yield* runtimes.updateThread(threadId, (t) => {
            if (ref !== undefined && !(t.boundPr !== undefined && samePr(t.boundPr, ref))) {
              return removeExtraPr(t, ref);
            }
            const { boundPr, ...rest } = t;
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
          yield* refreshes.request(thread.checkout.path, true);
          return { unbound: true };
        }).pipe(Effect.mapError(failed("pr_unbind"))),
    });

    const prStatus = defineAppTool({
      descriptor: {
        name: "pr_status",
        class: "read",
        description:
          "A thread's pull request from Gram's cached gh state: state, checks, resolved merge review policy, under solo Gram's own full check of its head merged onto its base (running, passed or failed with why, which merge_when_ready or local_check starts), and whether it's bound and monitored. This thread's unless threadId names another. Prefer this to polling gh.",
      },
      input: Schema.Struct({
        refresh: Schema.optionalKey(Schema.Boolean),
        threadId: Schema.optionalKey(Schema.NonEmptyString),
      }),
      handle: (caller, { refresh = false, threadId = caller }) =>
        Effect.gen(function* () {
          const thread = yield* store.getThread(threadId as ThreadId);
          yield* refuseOrchestratorPr("pr_status", thread);
          if (refresh) yield* refreshes.request(thread.checkout.path, true);
          const badge = yield* currentPr(thread);
          const repo =
            thread.boundPr?.repo ?? (badge === undefined ? undefined : repoFromPrUrl(badge.url));
          const reviewPolicy =
            repo === undefined ? undefined : yield* reviewPolicyFor(thread, repo);
          const configuration =
            localChecks === undefined
              ? undefined
              : yield* localChecks.configuration(thread.checkout.path, thread.projectId);
          // Solo merges accept Gram's own check of the head merged onto the base in place of CI.
          const localCheck =
            reviewPolicy === "solo" &&
            badge?.state === "OPEN" &&
            localChecks !== undefined &&
            configuration?.config?.refusal === undefined
              ? yield* localChecks.lookup(
                  thread.checkout.path,
                  badge.headRefOid,
                  badge.baseRefOid,
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
          // Nothing bound: watching binds the branch's PR, and not watching has nothing to do.
          if (!enabled) return { monitor: false };
          return { monitor: true, bound: yield* bind("pr_monitor", threadId, { monitor: true }) };
        }).pipe(Effect.mapError(failed("pr_monitor"))),
    });

    const setAutoMerge = defineAppTool({
      descriptor: {
        name: "set_auto_merge",
        class: "outward",
        description:
          "Merge a thread's pull request once GitHub allows it, or with enabled: false turn its auto-merge off: this thread's, or with threadId another's; its bound PR, else its branch's, unless number names another in the same repo. Solo development must use merge_when_ready for its CI and hold gates. A PR that can merge now (CLEAN) is merged at once, pinned to the head its badge showed; otherwise GitHub auto-merge is armed and merges it when its requirements are met. The result's `merged` says it merged, `autoMerge` that it is armed. If a PR it armed is still open once it is clean, call it again. Branch protection is never bypassed. The user approves every call, except a worker on its own PR, or an orchestrator on its worker's, in a workspace whose autonomy is `full`: the PR its branch opened, in a workspace project.",
      },
      input: Schema.Struct({
        enabled: Schema.optionalKey(Schema.Boolean),
        method: Schema.optionalKey(Schema.Literals(["squash", "merge", "rebase"])),
        number: Schema.optionalKey(Schema.Int),
        threadId: Schema.optionalKey(Schema.NonEmptyString),
      }),
      // An orchestrator on its own worker's PR, or a worker on its own, at `full` (`mergeDelegated`),
      // and in either case only on a PR `workerOwnsPr` finds is the worker's, whichever PR the call
      // resolved to.
      delegatedAtFullAutonomy: (caller, { number }, target: MergeTarget) =>
        Effect.gen(function* () {
          const { thread } = target;
          // A worker's exception is for its own PR alone, not any number it names.
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
      resolve: (caller, { enabled = true, method = "squash", number, threadId = caller }) =>
        Effect.gen(function* () {
          const tool = "set_auto_merge";
          const thread = yield* store
            .getThread(threadId as ThreadId)
            .pipe(Effect.mapError(failed(tool)));
          yield* refuseOrchestratorPr(tool, thread);
          yield* refuseInBabysit(thread);
          yield* refuseOverHold(tool, caller, thread);
          const cwd = thread.checkout.path;
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
          const state = yield* publisher.stateFor(cwd);
          // A number that isn't the bound PR's is in the checkout's own repo, which gh is then
          // told by name, so the card's repo is the one merged in.
          const repo =
            bound?.number === target
              ? bound.repo
              : ((branch === undefined ? undefined : repoFromPrUrl(branch.url)) ??
                state?.origin ??
                (yield* originOwnerRepo(cwd).pipe(Effect.provideService(Proc, proc))));
          // A card that can't name the repo would leave gh to pick one the user never saw.
          if (repo === undefined) {
            return yield* new AppToolError({
              tool,
              message: `Can't tell which repository #${target} is in; bind it with pr_bind repo and number.`,
            });
          }
          if (enabled) yield* requireGitHubAutoPolicy(thread, repo);
          // Only badges already fetched: naming the PR costs GitHub nothing.
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
          return {
            thread,
            other: threadId !== caller,
            enabled,
            method,
            number: target,
            repo,
            ...(seen === undefined
              ? {}
              : { title: seen.title, head: seen.headRefOid, mergeState: seen.mergeState }),
          } satisfies MergeTarget;
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
      handle: (caller, { thread, other, enabled, method, number, repo, head, mergeState }, call) =>
        Effect.gen(function* () {
          const tool = "set_auto_merge";
          const cwd = thread.checkout.path;
          /**
           * The thread as it stands, under the lock `merge_when_ready` changes intents under: babysit
           * may have started while the card waited, the orchestrator may have held the merge, and a
           * waived card must still be waived for the very PR this merges.
           */
          const stillAllowed = Effect.gen(function* () {
            const latest = yield* store.getThread(thread.id);
            yield* refuseInBabysit(latest);
            if (enabled) {
              yield* refuseOverHold(tool, caller, latest);
              yield* requireGitHubAutoPolicy(latest, repo);
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
            gh(cwd, [...args, "--repo", repo]).pipe(Effect.provideService(Proc, proc));
          const view = (field: string) =>
            run(["pr", "view", String(number), "--json", field, "--jq", `.${field}`]).pipe(
              Effect.map((out) => (out.status === 0 ? out.stdout.trim() : "")),
            );
          const merge = (pin: string) =>
            run(["pr", "merge", String(number), `--${method}`, "--match-head-commit", pin]);
          const fail = (out: ProcOutput) =>
            new AppToolError({ tool, message: gitFailMsg(out, "gh pr merge failed") });

          const go = Effect.gen(function* () {
            yield* stillAllowed;
            let merged = false;
            if (!enabled) {
              const out = yield* run(["pr", "merge", String(number), "--disable-auto"]);
              if (out.status !== 0) return yield* fail(out);
            } else if (mergeState === "CLEAN" && head !== undefined) {
              const out = yield* merge(head);
              if (out.status !== 0) return yield* fail(out);
              merged = true;
            } else {
              const armed = yield* run(["pr", "merge", String(number), "--auto", `--${method}`]);
              if (armed.status === 0) {
                // gh merges at once when it reads the PR as mergeable, and says nothing either way.
                merged = (yield* view("state")) === "MERGED";
              } else if (CLEAN_STATUS.test(armed.stderr)) {
                // GitHub computes the merge state lazily, so gh can read BLOCKED or UNKNOWN from a
                // PR that is clean by the time it asks to arm auto-merge, which GitHub then refuses.
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
          });
          const merged = yield* mergeWhenReady === undefined
            ? go
            : mergeWhenReady.mutate(thread.id, go);
          // The badge is asked again now, not answered from before the call, and on every sweep
          // while GitHub catches up.
          invalidatePrBadges();
          yield* refreshes.request(cwd, true, { expectChange: true });
          return {
            ...(other ? { threadId: thread.id } : {}),
            number,
            ...(enabled ? { merged, autoMerge: !merged, method } : { autoMerge: false }),
          };
        }).pipe(Effect.mapError(failed("set_auto_merge"))),
    });

    const runMonitorTool = defineAppTool({
      descriptor: {
        name: "run_monitor",
        class: "self",
        description:
          "Watch a GitHub Actions run, such as a release build or a deploy, and end your turn: when it completes, Gram sends one message into this thread with its conclusion, the jobs that failed and its link. Name it by `run` (its id or its page's URL) or by `workflow` (file name or name, with `branch` to narrow it) for its latest run; `repo` defaults to the thread's pull request's, else origin's. A run already completed is answered at once. It survives a restart. With enabled: false, stop watching `run`, or every run. Use it instead of `gh run watch`, which holds your turn and dies with it; for a pull request's own checks, use pr_review_monitor.",
      },
      input: Schema.Struct({
        run: Schema.optionalKey(Schema.String),
        workflow: Schema.optionalKey(Schema.String),
        branch: Schema.optionalKey(Schema.String),
        repo: Schema.optionalKey(Schema.String),
        enabled: Schema.optionalKey(Schema.Boolean),
      }),
      audience: OWN_PR_AUDIENCE,
      handle: (threadId, { enabled = true, ...input }) =>
        Effect.gen(function* () {
          if (runMonitor === undefined) {
            return yield* new AppToolError({
              tool: "run_monitor",
              message: "Run monitoring isn't available here.",
            });
          }
          if (!enabled) {
            const ref = input.run === undefined ? undefined : parseRunRef(input.run);
            // Only a call that names no run stops them all; a typo mustn't.
            if (input.run !== undefined && ref === undefined) {
              return yield* new AppToolError({
                tool: "run_monitor",
                message: `"${input.run}" is neither a run id nor a run's URL.`,
              });
            }
            return { stopped: yield* runMonitor.unwatch(threadId, ref?.runId) };
          }
          const result = yield* runMonitor.watch(threadId, input);
          return result.watch === undefined
            ? { watching: false, completed: result.completed }
            : { watching: true, run: result.watch };
        }),
    });

    /**
     * Whether `caller` merging `thread`'s PR goes without a card: an orchestrator on its own worker,
     * or a worker on the open PR its own branch opened, in a workspace at `full` autonomy.
     */
    const mergeDelegated = (caller: ThreadId, thread: Thread) =>
      Effect.gen(function* () {
        if (orchestration === undefined) return false;
        if (thread.id !== caller) return yield* orchestration.fullAutonomyAllows(caller, thread.id);
        return yield* orchestration.workerMergesOwn(caller);
      }).pipe(Effect.catchCause(() => Effect.succeed(false)));

    const MERGE = "merge_when_ready";

    const mergeWhenReadyTool = defineAppTool({
      descriptor: {
        name: MERGE,
        class: "outward",
        description:
          "Merge a pull request once it is ready, then end your turn: Gram squash-merges it (or `method`), pinned with --match-head-commit to the head it checked, as soon as the workspace's merge review policy is satisfied, required checks are green and GitHub would merge it. Defaults to this thread's bound PR or its branch's new PR; threadId targets your worker. `pr` names a number in its checkout's repo, or owner/repo#N (or URL), including a stacked PR; arming binds it, unless another PR already has an intent. `after` lists PRs (`owner/repo#N` or URLs) that must have merged first, such as a release PR; `hold` keeps it waiting, with why, until a call with `release: true` or `hold: null` (an empty or whitespace-only hold also clears it), and `holdWaitsOn` says on whom: `person` (the default) for the user or a reviewer, `agent` for an agent's work, such as a review bot's re-review or another worker's change. What an orchestrator holds, its worker can't lift. enabled: false drops the intent. The thread is told when it merges, or why GitHub refused. The user approves the call, except a worker on its own PR, or an orchestrator on its worker's, in a workspace whose autonomy is `full`: an open, non-fork PR from a branch observed in a worktree the worker holds in a workspace project. The same orchestrator may maintain or release an identical intent carrying its explicit user approval without another card in Full Auto; changes of target, method or scope still ask. Approvals without that provenance still ask. A worker's call on an orchestrator-held intent still asks. There the autonomy is asked again before merging.",
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
          if (thread.babysit !== undefined) {
            return yield* new AppToolError({
              tool: MERGE,
              message: "Not in babysit mode, where the user merges.",
            });
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
          const branch =
            input.pr === undefined && thread.boundPr === undefined
              ? yield* currentPr(thread)
              : undefined;
          const repo =
            named?.repo ??
            (typeof input.pr === "number"
              ? yield* originOwnerRepo(thread.checkout.path).pipe(Effect.provideService(Proc, proc))
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
            // Capture this approval instance before the gate: a replacement cannot inherit its waiver.
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
      // After `resolve`, which the target's type is inferred from.
      delegatedAtFullAutonomy: (caller, _input, { thread, pr, reuseApproval }) =>
        Effect.gen(function* () {
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
              ))
            );
          }
          return yield* workerOwnsPr(thread, pr.repo, pr.number);
        }).pipe(Effect.catchCause(() => Effect.succeed(false))),
      describe: (caller, { thread, pr, enabled = true, method, afterRefs, hold, clearHold }) =>
        Effect.gen(function* () {
          if (!enabled) return `Stop merging ${prName(pr)} when it is ready`;
          const policy = yield* reviewPolicyFor(thread, pr.repo);
          const condition =
            policy === "solo"
              ? "fresh CI passes, or Gram's own full check of it merged onto its base passes, and GitHub allows it"
              : "it is approved on its head, green and clean";
          const ownership = (yield* mergeDelegated(caller, thread))
            ? yield* workerPrOwnership(thread, pr.repo, pr.number).pipe(
                Effect.provideService(ThreadStore, store),
                Effect.provideService(Proc, proc),
              )
            : undefined;
          const ownershipReason =
            typeof ownership === "string"
              ? ` Approval is required because PR ownership could not be verified: ${ownership}. No matching scoped user approval covers this call.`
              : "";
          // Metadata only: no card body, thread title, account data or prompt text in diagnostics.
          yield* Effect.logInfo("merge approval context").pipe(
            Effect.annotateLogs({
              callerThreadId: caller,
              targetThreadId: thread.id,
              repo: pr.repo,
              number: pr.number,
              method,
              reason:
                typeof ownership === "string"
                  ? ownership
                  : ownership === undefined
                    ? "no-current-scoped-delegation"
                    : "owned-worktree-branch",
            }),
          );
          return `Merge ${prName(pr)} (${method ?? thread.boundPr?.mergeWhenReady?.method ?? "squash"}) once ${condition}${afterRefs.length === 0 ? "" : `, after ${afterRefs.map(prName).join(", ")}`}${clearHold ? ", no hold" : hold === undefined ? "" : `, held: ${hold}`}${thread.id === caller ? "" : `, on “${thread.title}”`}${ownershipReason}`;
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
        },
        call,
      ) =>
        Effect.gen(function* () {
          // Babysit may have started while the card waited, or the orchestrator held the merge.
          const latest = yield* store.getThread(thread.id);
          if (latest.babysit !== undefined) {
            return yield* new AppToolError({ tool: MERGE, message: "Not in babysit mode." });
          }
          if (!enabled) yield* refuseOverHold(MERGE, caller, latest);
          const byOrchestrator = thread.id !== caller;
          // The gate's own verdict says whether a card stood behind the call. Waived, it must be
          // waived for this very PR as things stand now, not for whatever was bound when it asked.
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
            ))
          ) {
            return yield* new AppToolError({
              tool: MERGE,
              message: "The approved pull request identity changed during the call; call it again.",
            });
          }
          const ownership =
            allowedBy === "autonomy"
              ? yield* workerPrOwnership(latest, pr.repo, pr.number).pipe(
                  Effect.provideService(ThreadStore, store),
                  Effect.provideService(Proc, proc),
                )
              : undefined;
          // Binding follows arming; the fresh ownership check covers stacked and unbound PRs too.
          const stillWaived =
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
              if (t.parked || t.babysit !== undefined) {
                refused =
                  "This thread is parked or in babysit mode; call it again after that changes.";
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
              const { mergeWhenReady: current, ...rest } = bound;
              // Read again in the write: a hold committed since the check above stands.
              if (!enabled && current?.heldBy === "orchestrator" && !byOrchestrator) {
                refused = heldMessage(current);
                return t;
              }
              if (!enabled) return current === undefined ? t : bindMainPr(t, rest);
              // What the orchestrator set stands against its worker's call; its own call replaces it.
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
              // Who a hold waits on goes with it: a new hold says so afresh, a kept one keeps it.
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
              // The gate is read-only; remember its reverified branch atomically with arming so a
              // switch before the next publisher sample cannot drop this intent.
              const owned =
                typeof ownership === "object"
                  ? withOwnedBranch(t, ownership.path, ownership.branch)
                  : t;
              return bindMainPr(owned, { ...rest, mergeWhenReady: intent });
            },
            reusing || (call.carded === true && byOrchestrator) ? caller : undefined,
          );
          // With no attempt of the old intent between its last look and its launch meanwhile.
          const updated = yield* mergeWhenReady === undefined
            ? write
            : mergeWhenReady.mutate(thread.id, write);
          if (refused !== undefined)
            return yield* new AppToolError({ tool: MERGE, message: refused });
          yield* refreshes.request(updated.checkout.path, true);
          const intent = updated.boundPr?.mergeWhenReady;
          if (intent === undefined) return { pr: prName(pr), mergeWhenReady: false };
          const configuration =
            localChecks === undefined
              ? undefined
              : yield* localChecks.configuration(updated.checkout.path, updated.projectId);
          const localGate =
            (yield* reviewPolicyFor(updated, pr.repo)) === "solo" &&
            configuration !== undefined &&
            configuration.config === undefined
              ? { status: "off", reason: configuration.reason }
              : undefined;
          if (localGate !== undefined && updated.workspaceId !== undefined)
            yield* store.appendOrchestrationEvent(updated.workspaceId, {
              at: yield* Clock.currentTimeMillis,
              kind: "localGateOff",
              data: { threadId: updated.id, pr: prName(pr), localGate },
            });
          const badge = yield* publisher.badgeFor(updated);
          const waiting =
            badge === undefined
              ? "its state isn't known yet"
              : mergeBlocker(
                  intent,
                  badge,
                  yield* reviewPolicyFor(updated, pr.repo),
                  reviewBotsOf(yield* store.getSettings),
                );
          return {
            ...(byOrchestrator ? { threadId: thread.id } : {}),
            pr: prName(pr),
            mergeWhenReady: true,
            ...(localGate === undefined ? {} : { localGate }),
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
          "Under the solo merge review policy, has Gram run its own full check of your bound pull request now, ahead of merge_when_ready: the head GitHub has, merged onto its base's current tip, in a clean worktree on this machine. It runs the PR's own code outside your sandbox, so the user approves the call, except on your own PR (the one your worktree's branch opened) in a workspace whose autonomy is `full`. A pass Gram recorded for that exact head, base and check is reused rather than run again, and merge_when_ready accepts it in place of CI; a failure is run again, unless `rerun: false`, which only reports what Gram has recorded. You are told how it ends, with why it failed. A push, moved base or changed command/setup/timeout needs a new check. No configured command means the local gate is OFF; CI and GitHub rules apply. Nothing you claim or run yourself counts as a pass.",
      },
      input: Schema.Struct({ rerun: Schema.optionalKey(Schema.Boolean) }),
      audience: OWN_PR_AUDIENCE,
      // Only a worker on its own PR, in a workspace whose orchestration delegates it its merges.
      delegatedAtFullAutonomy: (caller) =>
        Effect.gen(function* () {
          const thread = yield* store.getThread(caller);
          const bound = thread.boundPr;
          if (bound === undefined || !(yield* mergeDelegated(caller, thread))) return false;
          return yield* workerOwnsPr(thread, bound.repo, bound.number);
        }).pipe(Effect.catchCause(() => Effect.succeed(false))),
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

    yield* registry.register([
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
