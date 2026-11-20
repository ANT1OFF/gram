import { randomUUID } from "node:crypto";

import { AgentUnavailable, MessageId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
import type { AgentHost } from "../host.ts";
import { startAcpAgent } from "./acp.ts";
import { makeGrokHost } from "./session.ts";

export class GrokHost extends Context.Service<GrokHost, AgentHost>()("@gram/agents/GrokHost") {}

export interface GrokHostLiveConfig {
  /** Login shell for the PATH probe; defaults to `$SHELL`, then the platform's. */
  readonly shell?: string;
  /** A `grok` to use instead of the one on the login-shell PATH. */
  readonly binaryPath?: string;
}

const inherited = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter((each): each is [string, string] => each[1] !== undefined),
  );

/**
 * `GrokHost` backed by the user's installed Grok Build (`grok`), found on the login-shell PATH,
 * with that shell's environment, on the user's own sign-in. Nothing is looked for until a session
 * or a list needs it.
 */
export const GrokHostLive = (config: GrokHostLiveConfig = {}): Layer.Layer<GrokHost> =>
  Layer.effect(GrokHost)(
    Effect.gen(function* () {
      const probe = yield* resettableOnSuccess(
        process.platform === "win32"
          ? Effect.succeed<ProbeResult>({ env: inherited() })
          : runCommand(
              config.shell ??
                process.env["SHELL"] ??
                (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash"),
              ["-ilc", probeScript("grok")],
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
        const candidates = config.binaryPath
          ? [config.binaryPath]
          : [
              ...(probed.commandPath ? [probed.commandPath] : []),
              ...pathCandidates(
                Object.keys(probed.env).length > 0 ? probed.env : inherited(),
                process.platform,
                "grok",
              ),
            ];
        const found = yield* resolveBinary(candidates, nodeFs).pipe(
          Effect.mapError(
            () =>
              new AgentUnavailable({
                agent: "grok",
                message: "No grok executable on the login-shell PATH. Install Grok Build first.",
              }),
          ),
        );
        return found.path;
      });
      return yield* makeGrokHost({
        binary,
        env,
        start: startAcpAgent,
        newMessageId: () => MessageId.make(randomUUID()),
      });
    }),
  );
