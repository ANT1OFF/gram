import { AgentUnavailable, type AgentKind } from "@gram/contracts";
import * as Effect from "effect/Effect";

import { resettableOnSuccess } from "../cli/cache.ts";
import {
  nodeFs,
  parseProbeOutput,
  pathCandidates,
  probeScript,
  resolveBinary,
  type ProbeResult,
} from "../cli/discovery.ts";
import { runCommand } from "../cli/process.ts";

const inherited = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter((each): each is [string, string] => each[1] !== undefined),
  );

export interface LoginShellCli {
  readonly agent: AgentKind;
  /** The command's name on the PATH. */
  readonly command: string;
  /** What a missing executable says. */
  readonly missing: string;
  /** Login shell for the PATH probe; defaults to `$SHELL`, then the platform's. */
  readonly shell?: string | undefined;
  /** An executable to use instead of the one on the login-shell PATH. */
  readonly binaryPath?: string | undefined;
}

/**
 * A CLI found on the login-shell PATH, with that shell's environment: its executable, and the
 * environment it runs in. Nothing is looked for until one of them is asked for.
 */
export const loginShellCli = (
  cli: LoginShellCli,
): Effect.Effect<
  {
    readonly env: Effect.Effect<Record<string, string>>;
    readonly binary: Effect.Effect<string, AgentUnavailable>;
  },
  never
> =>
  Effect.gen(function* () {
    const probe = yield* resettableOnSuccess(
      process.platform === "win32"
        ? Effect.succeed<ProbeResult>({ env: inherited() })
        : runCommand(
            cli.shell ??
              process.env["SHELL"] ??
              (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash"),
            ["-ilc", probeScript(cli.command)],
            { timeoutMs: 5_000, isolateSession: true },
          ).pipe(
            Effect.map((output) => parseProbeOutput(output.stdout)),
            Effect.orElseSucceed((): ProbeResult => ({ env: inherited() })),
          ),
    );
    const env = probe.get.pipe(
      Effect.map((probed) => (Object.keys(probed.env).length > 0 ? probed.env : inherited())),
    );
    const binary = Effect.gen(function* () {
      const probed = yield* probe.get;
      const candidates = cli.binaryPath
        ? [cli.binaryPath]
        : [
            ...(probed.commandPath ? [probed.commandPath] : []),
            ...pathCandidates(
              Object.keys(probed.env).length > 0 ? probed.env : inherited(),
              process.platform,
              cli.command,
            ),
          ];
      const found = yield* resolveBinary(candidates, nodeFs).pipe(
        Effect.mapError(() => new AgentUnavailable({ agent: cli.agent, message: cli.missing })),
      );
      return found.path;
    });
    return { env, binary };
  });
