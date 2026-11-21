import { randomUUID } from "node:crypto";

import { MessageId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { AgentHost } from "../host.ts";
import { startAcpAgent } from "../acp/connection.ts";
import { loginShellCli } from "../acp/live.ts";
import { makeAntigravityHost } from "./session.ts";

export class AntigravityHost extends Context.Service<AntigravityHost, AgentHost>()(
  "@gram/agents/AntigravityHost",
) {}

export interface AntigravityHostLiveConfig {
  /**
   * The environment Antigravity starts with, given the login shell's, once its config folder of
   * Gram's own (`geminiDir`) is ready, so the person's Antigravity settings, permission rules,
   * hooks, servers, plugins, skills and rules stay out.
   */
  readonly ownedHome: (env: Record<string, string>) => Effect.Effect<Record<string, string>>;
  /** Antigravity's config folder (`--gemini-dir`), of Gram's own. */
  readonly geminiDir: string;
  /** Login shell for the PATH probe; defaults to `$SHELL`, then the platform's. */
  readonly shell?: string;
  /** An `agy` to use instead of the one on the login-shell PATH. */
  readonly binaryPath?: string;
}

/**
 * `AntigravityHost` backed by the user's installed Antigravity CLI (`agy`), found on the
 * login-shell PATH, with that shell's environment, on the user's own sign-in. Nothing is looked for
 * until a session or a list needs it.
 */
export const AntigravityHostLive = (
  config: AntigravityHostLiveConfig,
): Layer.Layer<AntigravityHost> =>
  Layer.effect(AntigravityHost)(
    Effect.gen(function* () {
      const cli = yield* loginShellCli({
        agent: "antigravity",
        command: "agy",
        missing: "No agy executable on the login-shell PATH. Install the Antigravity CLI first.",
        shell: config.shell,
        binaryPath: config.binaryPath,
      });
      return yield* makeAntigravityHost({
        binary: cli.binary,
        env: cli.env.pipe(Effect.flatMap(config.ownedHome)),
        args: Effect.succeed(["--gemini-dir", config.geminiDir]),
        start: startAcpAgent,
        newMessageId: () => MessageId.make(randomUUID()),
      });
    }),
  );
