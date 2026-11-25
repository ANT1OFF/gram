import { createHash } from "node:crypto";
import {
  type HostFailed,
  type WorktreeHookInspection,
  type WorktreeHookOutcome,
  type WorktreeHookRequest,
  type WorktreeHookRun,
} from "@gram/contracts";
import { Proc, type ProcShape } from "@gram/git";
import * as Effect from "effect/Effect";
import { runWorktreeHook, sanitizeHookText } from "./worktree-hook-runner.ts";
import { resolveWorktreeHook, WORKTREE_HOOK_VERSION } from "./worktree-hook-source.ts";

export interface HostWorktreeHooks<E = HostFailed> {
  inspect(request: WorktreeHookRequest): Effect.Effect<WorktreeHookInspection, E>;
  run(
    request: WorktreeHookRun,
    interrupted?: (result: WorktreeHookOutcome) => Effect.Effect<void>,
  ): Effect.Effect<WorktreeHookOutcome, E>;
}

/** The trusted provider adapter replies after applying a successful artifact to this checkout. */
export interface PreparedSetupTarget {
  readonly checkout: string;
  readonly generation: string;
  readonly workspace: string;
  readonly repository: string;
  readonly environment: string;
  readonly environmentRevision: string;
  readonly policyRevision: string;
  readonly revision: string;
  readonly inputKey: string;
}

export interface ReusableSetup extends PreparedSetupTarget {
  readonly version: typeof WORKTREE_HOOK_VERSION;
  readonly resultId: string;
  readonly completedAt: number;
  readonly expiresAt: number;
}

interface HostedHooks {
  readonly enabled: boolean;
  readonly publicVariables?: Readonly<Record<string, string>>;
  readonly preparation?: {
    readonly environment: string;
    readonly environmentRevision: string;
    readonly policyRevision: string;
    readonly reuse: (target: PreparedSetupTarget) => Effect.Effect<ReusableSetup | undefined>;
  };
}

/** The opt-in comes from the host's launch configuration, outside the worker's checkout. */
export const hostedHooksFrom = (env: NodeJS.ProcessEnv): HostedHooks => ({
  enabled: env["GRAM_HOST_WORKTREE_HOOKS"] === "1" && (process.getuid?.() ?? 0) !== 0,
  publicVariables: Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) =>
      key.startsWith("GRAM_HOOK_PUBLIC_") && value !== undefined ? [[key, value]] : [],
    ),
  ),
});

const matchingReuse = (target: PreparedSetupTarget, result: ReusableSetup, now: number) =>
  result.version === WORKTREE_HOOK_VERSION &&
  /^[a-zA-Z0-9_-]{1,128}$/.test(result.resultId) &&
  Number.isFinite(result.completedAt) &&
  Number.isFinite(result.expiresAt) &&
  result.completedAt <= now &&
  result.expiresAt > now &&
  target.checkout === result.checkout &&
  target.generation === result.generation &&
  target.workspace === result.workspace &&
  target.repository === result.repository &&
  target.environment === result.environment &&
  target.environmentRevision === result.environmentRevision &&
  target.policyRevision === result.policyRevision &&
  target.revision === result.revision &&
  target.inputKey === result.inputKey;

const noPolicy = "The host provider has disabled worktree hooks for this environment.";
const skipped = (): WorktreeHookOutcome => ({
  status: "skipped",
  durationMs: 0,
  log: "",
  reason: noPolicy,
});
const failed = (reason: string): WorktreeHookOutcome => ({
  status: "failed",
  durationMs: 0,
  log: "",
  failure: "launch",
  reason,
});

export const worktreeHooksOn = (options: {
  readonly proc: ProcShape;
  readonly loginPath: Effect.Effect<string>;
  readonly stagingRoot: string;
  readonly admit?: (path: string) => Effect.Effect<string, HostFailed>;
  readonly hosted?: HostedHooks;
}): HostWorktreeHooks => {
  const checkoutOf = (path: string) => options.admit?.(path) ?? Effect.succeed(path);
  const lookup = (checkout: string, req: WorktreeHookRequest) =>
    resolveWorktreeHook(checkout, req.kind, req.revision).pipe(
      Effect.provideService(Proc, options.proc),
    );

  return {
    inspect: (req) =>
      Effect.gen(function* () {
        if (options.hosted?.enabled === false)
          return { status: "skipped" as const, reason: noPolicy };
        const checkout = yield* checkoutOf(req.checkout);
        const found = yield* lookup(checkout, req);
        if (found.status !== "found") return found;
        const { path, revision, fingerprint, script } = found.source;
        return {
          status: "found" as const,
          path,
          revision,
          fingerprint,
          script: sanitizeHookText(script),
        };
      }),
    run: (req, interrupted) =>
      Effect.gen(function* () {
        const beganAt = Date.now();
        if (options.hosted?.enabled === false) return skipped();
        const checkout = yield* checkoutOf(req.checkout);
        const found = yield* lookup(checkout, req);
        if (found.status !== "found")
          return failed(
            found.status === "invalid" ? found.reason : "The committed hook is missing.",
          );
        if (found.source.fingerprint !== req.fingerprint)
          return failed("The committed hook changed before it could run.");

        const preparation = options.hosted?.preparation;
        const { workspace, repository, generation, environment, revision } = req;
        if (
          req.kind === "setup" &&
          preparation !== undefined &&
          environment === preparation.environment &&
          workspace !== undefined &&
          repository !== undefined &&
          generation !== undefined
        ) {
          const { environmentRevision, policyRevision } = preparation;
          const inputKey = createHash("sha256")
            .update(
              JSON.stringify([
                WORKTREE_HOOK_VERSION,
                workspace,
                repository,
                environment,
                environmentRevision,
                policyRevision,
                process.platform,
                process.arch,
                found.source.fingerprint,
                found.source.tree,
              ]),
            )
            .digest("hex");
          const target = {
            checkout,
            generation,
            workspace,
            repository,
            environment,
            environmentRevision,
            policyRevision,
            revision,
            inputKey,
          };
          const hit = yield* preparation.reuse(target).pipe(
            Effect.timeoutOrElse({
              duration: "2 seconds",
              orElse: () => Effect.succeed(undefined),
            }),
            Effect.catchCause(() => Effect.succeed(undefined)),
          );
          if (hit !== undefined && matchingReuse(target, hit, Date.now()))
            return { status: "reused" as const, durationMs: 0, log: "", resultId: hit.resultId };
        }
        return yield* runWorktreeHook(checkout, found.source, {
          loginPath: yield* options.loginPath,
          approvedFingerprint: req.fingerprint,
          stagingRoot: options.stagingRoot,
          ...(req.budgetMs === undefined
            ? {}
            : { budgetMs: Math.max(0, req.budgetMs - (Date.now() - beganAt)) }),
          ...(interrupted === undefined ? {} : { interrupted }),
          ...(options.hosted?.publicVariables === undefined
            ? {}
            : { publicVariables: options.hosted.publicVariables }),
        });
      }),
  };
};
