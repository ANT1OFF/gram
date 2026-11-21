import { randomUUID } from "node:crypto";

import { MessageId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { AgentHost } from "../host.ts";
import { startAcpAgent } from "../acp/connection.ts";
import { loginShellCli } from "../acp/live.ts";
import { makeGrokHost } from "./session.ts";

export class GrokHost extends Context.Service<GrokHost, AgentHost>()("@gram/agents/GrokHost") {}

export interface GrokHostLiveConfig {
  /**
   * The environment Grok starts with, given the login shell's: a home of Gram's own, so the
   * person's Claude Code, Cursor and Grok settings, servers, plugins and allow rules stay out.
   */
  readonly ownedHome: (env: Record<string, string>) => Effect.Effect<Record<string, string>>;
  /** Login shell for the PATH probe; defaults to `$SHELL`, then the platform's. */
  readonly shell?: string;
  /** A `grok` to use instead of the one on the login-shell PATH. */
  readonly binaryPath?: string;
}

/**
 * `GrokHost` backed by the user's installed Grok Build (`grok`), found on the login-shell PATH,
 * with that shell's environment, on the user's own sign-in. Nothing is looked for until a session
 * or a list needs it.
 */
export const GrokHostLive = (config: GrokHostLiveConfig): Layer.Layer<GrokHost> =>
  Layer.effect(GrokHost)(
    Effect.gen(function* () {
      const cli = yield* loginShellCli({
        agent: "grok",
        command: "grok",
        missing: "No grok executable on the login-shell PATH. Install Grok Build first.",
        shell: config.shell,
        binaryPath: config.binaryPath,
      });
      return yield* makeGrokHost({
        binary: cli.binary,
        env: cli.env.pipe(Effect.flatMap(config.ownedHome)),
        start: startAcpAgent,
        newMessageId: () => MessageId.make(randomUUID()),
      });
    }),
  );
