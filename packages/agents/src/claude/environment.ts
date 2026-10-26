import { AgentUnavailable } from "@gram/contracts";
import { createRequire } from "node:module";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  authUnavailable,
  checkAuthStatus,
  parseCliVersion,
  parseProbeOutput,
  pathCandidates,
  PROBE_SCRIPT,
  requireSdkExecutable,
  resolveBinary,
  versionWarning,
} from "./binary.ts";
import { buildChildEnv } from "./env.ts";
import { runCommand } from "../cli/process.ts";
import { nodeFs } from "../cli/discovery.ts";
import { resettableOnSuccess } from "../cli/cache.ts";

import { ClaudeSdk } from "./sdk.ts";

export { nodeFs } from "../cli/discovery.ts";

export interface PreparedClaude {
  readonly binaryPath: string;
  /** What the Agent SDK spawns; undefined leaves it to the CLI the SDK bundles. */
  readonly sdkExecutable?: string | undefined;
  readonly env: Record<string, string>;
  readonly cliVersion?: string;
  /** Non-fatal problems to surface once per session (version skew, probe fallback). */
  readonly warnings: ReadonlyArray<string>;
}

export interface ClaudeEnvironmentShape {
  /** Resolves the binary and child env. Cached after the first success, until `invalidate`. */
  readonly prepare: Effect.Effect<PreparedClaude, AgentUnavailable>;
  /**
   * The executable changed on disk (the user updated their CLI): the next `prepare` resolves it
   * again, as a native install's realpath names the version it was.
   */
  readonly invalidate: Effect.Effect<void>;
  /** `claude auth status --json` must report a subscription login. */
  readonly checkAuth: (prepared: PreparedClaude) => Effect.Effect<void, AgentUnavailable>;
}

export class ClaudeEnvironment extends Context.Service<ClaudeEnvironment, ClaudeEnvironmentShape>()(
  "@gram/agents/ClaudeEnvironment",
) {}

export interface ClaudeEnvironmentConfig {
  /** Login shell for the PATH probe; defaults to `$SHELL`, then `/bin/zsh`. */
  readonly shell?: string;
  /** Skip discovery and use this executable. */
  readonly binaryPath?: string;
  readonly probeTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
}

/**
 * Whether the Agent SDK can find the CLI it bundles for this platform. It looks from its own module,
 * which in the desktop's server bundle is this file's too, so both bases are tried: this module
 * (bundled) and the SDK's entry (running from source). A packaged app ships neither.
 */
const hasBundledCli = (): boolean => {
  const cli = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${process.platform === "win32" ? ".exe" : ""}`;
  const bases = [
    () => import.meta.url,
    () => import.meta.resolve("@anthropic-ai/claude-agent-sdk"),
  ];
  return bases.some((base) => {
    try {
      createRequire(base()).resolve(cli);
      return true;
    } catch {
      // Not resolvable from this base; a CommonJS bundle has no `import.meta.resolve` at all.
      return false;
    }
  });
};

/**
 * What the Agent SDK spawns for the CLI at `binaryPath` (undefined: the CLI it bundles), or
 * `claude-not-found` when neither can run. A session's `prepare` and the launch checks both ask
 * this, so Diagnostics can't call an install usable that no thread can start from.
 */
export const claudeSdkExecutable = (
  binaryPath: string,
): Effect.Effect<string | undefined, AgentUnavailable> =>
  requireSdkExecutable(binaryPath, process.platform, nodeFs, hasBundledCli);

export const ClaudeEnvironmentLive = (
  config: ClaudeEnvironmentConfig = {},
): Layer.Layer<ClaudeEnvironment, never, ClaudeSdk> =>
  Layer.effect(ClaudeEnvironment)(
    Effect.gen(function* () {
      const sdk = yield* ClaudeSdk;
      const probeTimeoutMs = config.probeTimeoutMs ?? 5_000;
      const timeoutMs = config.commandTimeoutMs ?? 15_000;
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
      );

      const probe = Effect.gen(function* () {
        if (process.platform === "win32") return { env: inherited, warnings: [] };
        const shell = config.shell ?? process.env["SHELL"] ?? "/bin/zsh";
        return yield* runCommand(shell, ["-ilc", PROBE_SCRIPT], {
          timeoutMs: probeTimeoutMs,
          isolateSession: true,
        }).pipe(
          Effect.map((output) => ({ ...parseProbeOutput(output.stdout), warnings: [] })),
          Effect.catch((error) =>
            Effect.succeed({
              env: inherited,
              warnings: [
                `Login-shell probe failed (${error.message}); using the app's environment.`,
              ],
            }),
          ),
        );
      });

      const prepare = Effect.gen(function* () {
        const probed: {
          commandPath?: string;
          env: Record<string, string>;
          warnings: Array<string>;
        } = yield* probe;
        const candidates = config.binaryPath
          ? [config.binaryPath]
          : [
              ...(probed.commandPath ? [probed.commandPath] : []),
              ...pathCandidates(probed.env, process.platform),
            ];
        const binary = yield* resolveBinary(candidates, nodeFs);
        const env = buildChildEnv(probed.env);
        const version = yield* runCommand(binary.path, ["--version"], { env, timeoutMs }).pipe(
          Effect.map((output) => parseCliVersion(output.stdout)),
          Effect.catch(() => Effect.succeed(undefined)),
        );
        const warnings = [...probed.warnings];
        if (version === undefined)
          warnings.push(`Couldn't read the Claude Code version of ${binary.path}.`);
        const skew = version === undefined ? undefined : versionWarning(version, sdk.version);
        if (skew) warnings.push(skew);
        const sdkExecutable = yield* claudeSdkExecutable(binary.path);
        return {
          binaryPath: binary.path,
          sdkExecutable,
          env,
          ...(version === undefined ? {} : { cliVersion: version }),
          warnings,
        } satisfies PreparedClaude;
      });

      const checkAuth = (prepared: PreparedClaude) =>
        runCommand(prepared.binaryPath, ["auth", "status", "--json"], {
          env: prepared.env,
          timeoutMs,
        }).pipe(
          Effect.mapError(
            (error) =>
              new AgentUnavailable({
                agent: "claude",
                reason: "auth-status-failed",
                message: `Couldn't run \`claude auth status\`: ${error.message}`,
              }),
          ),
          Effect.flatMap((output) => {
            const problem = checkAuthStatus(output.stdout);
            return problem === undefined ? Effect.void : Effect.fail(authUnavailable(problem));
          }),
        );

      const prepared = yield* resettableOnSuccess(prepare);
      return {
        prepare: prepared.get,
        invalidate: prepared.reset,
        checkAuth,
      } satisfies ClaudeEnvironmentShape;
    }),
  );
