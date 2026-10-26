// The git services the server depends on, with no dependency on the server core, so `main.ts` can
// provide them from outside `ServerLayer`.

import {
  CheckpointsLive,
  GitStateRuntimeLive,
  PathProbeNonBlockingLive,
  Pr,
  PR_POLL_TTL_MS,
  PrBadgeTtlMs,
  PrLive,
  ProcNonBlockingLive,
  ReviewBots,
  ToolsLive,
  WorktreesLive,
  type Checkpoints,
  type GitStateRuntime,
  type PathProbe,
  type Proc,
  type Tools,
  type Worktrees,
} from "@gram/git";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { monitoredProc, RateLimitMonitor } from "../github/rate-limit-monitor.ts";
import { GhBudget, GhPriority } from "../github/budget.ts";
import { OpenPrs } from "../github/open-prs.ts";
import { GhQuota } from "../github/quota.ts";
import { PrActions } from "./pr-actions.ts";
import { PrReviews } from "./review.ts";
import { testTools } from "./test-tools.ts";

export interface GitServerConfigShape {
  /** Network-tier sweep cadence (PR badges, background fetch); `undefined` disables sweeps. */
  readonly sweepInterval: Duration.Duration | undefined;
  /**
   * How many checkouts one sweep refreshes at a time. Each refresh runs several `git` and `gh`
   * processes, so an unbounded sweep starts a burst that grows with the number of open threads.
   */
  readonly sweepConcurrency: number;
  /** Quiet window after a bot round lands before `pr.reviewRound` is published. */
  readonly reviewRoundDebounce: Duration.Duration;
  /** How long monitored checks must stay settled before the CI message is queued. */
  readonly monitorSettleDelay: Duration.Duration;
  /** How long a babysat head may sit without a bot verdict before the re-review command is posted. */
  readonly babysitQuietWindow: Duration.Duration;
  /** How often watched workflow runs (`run_monitor`) are looked up; a minute when absent. */
  readonly runPollInterval?: Duration.Duration | undefined;
}

export class GitServerConfig extends Context.Service<GitServerConfig, GitServerConfigShape>()(
  "@gram/server/GitServerConfig",
) {
  static readonly defaults: GitServerConfigShape = {
    sweepInterval: Duration.seconds(15),
    sweepConcurrency: 4,
    reviewRoundDebounce: Duration.seconds(10),
    monitorSettleDelay: Duration.seconds(30),
    babysitQuietWindow: Duration.minutes(10),
  };

  /**
   * The defaults, with `GRAM_GIT_SWEEP_MS`, `GRAM_GIT_SETTLE_MS`,
   * `GRAM_BABYSIT_QUIET_MS` and `GRAM_REVIEW_DEBOUNCE_MS` overriding the sweep cadence,
   * the checks-settle delay, the babysit re-review quiet window and the review-round debounce, so the
   * real-server e2e flows don't wait out production timers.
   */
  static readonly fromEnv = (
    env: Record<string, string | undefined> = process.env,
  ): GitServerConfigShape => {
    const millis = (name: string) => {
      const value = Number(env[name]);
      return env[name] !== undefined && env[name] !== "" && Number.isFinite(value) && value > 0
        ? Duration.millis(value)
        : undefined;
    };
    const sweepInterval = millis("GRAM_GIT_SWEEP_MS");
    const monitorSettleDelay = millis("GRAM_GIT_SETTLE_MS");
    const babysitQuietWindow = millis("GRAM_BABYSIT_QUIET_MS");
    const reviewRoundDebounce = millis("GRAM_REVIEW_DEBOUNCE_MS");
    return {
      ...GitServerConfig.defaults,
      ...(sweepInterval === undefined ? {} : { sweepInterval }),
      ...(monitorSettleDelay === undefined ? {} : { monitorSettleDelay }),
      ...(babysitQuietWindow === undefined ? {} : { babysitQuietWindow }),
      ...(reviewRoundDebounce === undefined ? {} : { reviewRoundDebounce }),
    };
  };
}

export interface RefreshRequest {
  readonly cwd: string;
  /** Also refresh the network tier. */
  readonly remote: boolean;
  /**
   * GitHub is about to react to what just happened — a push starts CI, a rerun restarts it, a
   * re-review command starts a round — so the checkout is asked about on every sweep for a while,
   * however cool it had gone.
   */
  readonly expectChange?: boolean;
  /**
   * Who asked, as `GhPriority` stood where `request` was called. The queue is drained by one
   * long-lived fiber, and a fiber-local reference doesn't cross into it: without this, babysit's
   * and the monitors' refreshes ran as the drain's own `interactive` and could spend the tenth of
   * the allowance that background work is meant to leave alone.
   */
  readonly priority: GhPriority;
}

/**
 * Requests for a git-state refresh. A queue rather than a publisher call, so turn hooks (which the
 * runtime depends on) never depend on the publisher (which depends on the runtime).
 */
export class GitRefresh extends Context.Service<
  GitRefresh,
  {
    readonly request: (
      cwd: string,
      remote: boolean,
      options?: { readonly expectChange?: boolean },
    ) => Effect.Effect<void>;
    readonly requests: Queue.Queue<RefreshRequest>;
  }
>()("@gram/server/GitRefresh") {
  static readonly layer = Layer.effect(
    GitRefresh,
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<RefreshRequest>();
      return {
        request: (cwd, remote, options) =>
          Effect.flatMap(GhPriority, (priority) =>
            Queue.offer(requests, {
              cwd,
              remote,
              priority,
              ...(options?.expectChange === true ? { expectChange: true } : {}),
            }),
          ).pipe(Effect.asVoid),
        requests,
      };
    }),
  );
}

export type GitPlatform =
  | Proc
  | PathProbe
  | Tools
  | Pr
  | Worktrees
  | GitStateRuntime
  | Checkpoints
  | GitRefresh
  | GitServerConfig
  | ReviewBots
  | RateLimitMonitor
  | GhBudget
  | GhQuota
  | OpenPrs
  | PrReviews
  | PrActions;

const platform = (
  pr: Layer.Layer<Pr, never, Proc | Tools | ReviewBots>,
  prReviews: Layer.Layer<PrReviews, never, Proc | Tools>,
  prActions: Layer.Layer<PrActions, never, Proc>,
  config: GitServerConfigShape,
  quota: Layer.Layer<GhQuota, never, Proc | Tools>,
  openPrs: Layer.Layer<OpenPrs, never, Proc | Tools>,
  proc: Layer.Layer<Proc> = ProcNonBlockingLive,
  tools: Layer.Layer<Tools, never, PathProbe | Proc> = ToolsLive,
): Layer.Layer<GitPlatform> =>
  Layer.mergeAll(
    GitStateRuntimeLive,
    WorktreesLive,
    CheckpointsLive,
    GitRefresh.layer,
    prReviews,
    prActions,
    quota,
    openPrs,
    Layer.succeed(GitServerConfig, config),
  ).pipe(
    Layer.provideMerge(pr),
    Layer.provideMerge(tools),
    Layer.provideMerge(
      Layer.mergeAll(monitoredProc(proc), PathProbeNonBlockingLive, ReviewBots.layer).pipe(
        Layer.provideMerge(Layer.mergeAll(RateLimitMonitor.layer, GhBudget.layer)),
      ),
    ),
  );

/**
 * The badge TTL for a sweep cadence: the usual one, held to two thirds of a faster sweep so every
 * sweep still reaches GitHub. Only `GRAM_GIT_SWEEP_MS` makes a sweep that fast.
 */
export const badgeTtlMs = (config: GitServerConfigShape): number =>
  config.sweepInterval === undefined
    ? PR_POLL_TTL_MS
    : Math.min(PR_POLL_TTL_MS, Math.floor((Duration.toMillis(config.sweepInterval) * 2) / 3));

const liveConfig = GitServerConfig.fromEnv();

export const GitPlatformLive = platform(
  PrLive.pipe(Layer.provide(Layer.succeed(PrBadgeTtlMs, badgeTtlMs(liveConfig)))),
  PrReviews.layer,
  PrActions.layer,
  liveConfig,
  GhQuota.layer,
  OpenPrs.layer,
);

/** No `gh`: PR lookups find nothing. */
const NoPr = Layer.succeed(Pr, {
  status: () => Effect.succeed(undefined),
  checks: () => Effect.succeed([]),
  prime: () => Effect.void,
  seenChecks: () => Effect.succeed(undefined),
  detail: () => Effect.succeed({ available: false }),
});

/** Real git over temp repos, mocked PR services, no account probes and no network sweeps. */
export const gitPlatformTest = (
  options: {
    readonly pr?: Layer.Layer<Pr, never, Proc | Tools | ReviewBots>;
    readonly prReviews?: Layer.Layer<PrReviews>;
    readonly prActions?: Layer.Layer<PrActions>;
    readonly config?: Partial<GitServerConfigShape>;
    readonly quota?: Layer.Layer<GhQuota>;
    readonly openPrs?: Layer.Layer<OpenPrs>;
    /** Every process the platform starts goes through it, so a harness can watch them. */
    readonly proc?: Layer.Layer<Proc>;
    /** Explicit host readiness; omitted means git present, gh missing, Claude missing. */
    readonly tools?: Layer.Layer<Tools>;
  } = {},
): Layer.Layer<GitPlatform> =>
  platform(
    options.pr ?? NoPr,
    options.prReviews ?? PrReviews.layerOffline,
    options.prActions ?? PrActions.layerOffline,
    {
      ...GitServerConfig.defaults,
      sweepInterval: undefined,
      monitorSettleDelay: Duration.zero,
      ...options.config,
    },
    options.quota ?? GhQuota.layerNone,
    options.openPrs ?? OpenPrs.layerNone,
    options.proc,
    options.tools ?? testTools({ git: true, gh: "missing", claude: false }),
  );
