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
import { GatewayKeyProvider } from "../gateway.ts";
import type { AgentHost } from "../host.ts";
import { startOpenCodeServer } from "./server.ts";
import { makeOpenCodeHost } from "./session.ts";

export class OpenCodeHost extends Context.Service<OpenCodeHost, AgentHost>()(
  "@gram/agents/OpenCodeHost",
) {}

export interface OpenCodeHostLiveConfig {
  /** Login shell for the PATH probe; defaults to `$SHELL`, then the platform's. */
  readonly shell?: string;
  /** An `opencode` to use instead of the one on the login-shell PATH. */
  readonly binaryPath?: string;
}

const inherited = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter((each): each is [string, string] => each[1] !== undefined),
  );

/**
 * `OpenCodeHost` backed by the user's installed `opencode`, found on the login-shell PATH, with
 * that shell's environment. Nothing is looked for until a session or a list needs it.
 */
export const OpenCodeHostLive = (
  config: OpenCodeHostLiveConfig = {},
): Layer.Layer<OpenCodeHost, never, GatewayKeyProvider> =>
  Layer.effect(OpenCodeHost)(
    Effect.gen(function* () {
      const gateway = yield* GatewayKeyProvider;
      const probe = yield* resettableOnSuccess(
        process.platform === "win32"
          ? Effect.succeed<ProbeResult>({ env: inherited() })
          : runCommand(
              config.shell ??
                process.env["SHELL"] ??
                (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash"),
              ["-ilc", probeScript("opencode")],
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
                "opencode",
              ),
            ];
        const found = yield* resolveBinary(candidates, nodeFs).pipe(
          Effect.mapError(
            () =>
              new AgentUnavailable({
                agent: "opencode",
                message: "No opencode executable on the login-shell PATH.",
              }),
          ),
        );
        return found.path;
      });
      return yield* makeOpenCodeHost({
        binary,
        env,
        credentials: (profileId) => gateway.credentials(profileId, "opencode"),
        start: startOpenCodeServer,
        newMessageId: () => MessageId.make(randomUUID()),
      });
    }),
  );
