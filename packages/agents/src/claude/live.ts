import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";

import { ClaudeSdk } from "./sdk.ts";
import { makeClaudeHelper } from "./helper.ts";
import {
  ClaudeEnvironment,
  ClaudeEnvironmentLive,
  type ClaudeEnvironmentConfig,
} from "./environment.ts";
import { readClaudeEverConnected } from "./mcp-config-file.ts";
import { ClaudeSdkLive } from "./sdk-live.ts";
import { ClaudeHostLayer, ClaudeHost, type ClaudeHostConfig } from "./session.ts";

export interface ClaudeHostLiveConfig extends ClaudeHostConfig {
  readonly environment?: ClaudeEnvironmentConfig;
}

/**
 * `ClaudeHost` backed by the real Agent SDK and the user's installed `claude`, which reads which
 * claude.ai connectors Claude Code has ever connected from its config.
 */
export const ClaudeHostLive = (config: ClaudeHostLiveConfig = {}): Layer.Layer<ClaudeHost> =>
  Layer.effect(
    ClaudeHost,
    Effect.gen(function* () {
      const host = yield* ClaudeHost;
      const environment = yield* ClaudeEnvironment;
      const sdk = yield* ClaudeSdk;
      return { ...host, helper: makeClaudeHelper(environment, sdk) };
    }),
  ).pipe(
    Layer.provide(ClaudeHostLayer({ readEverConnected: readClaudeEverConnected, ...config })),
    Layer.provide(ClaudeEnvironmentLive(config.environment)),
    Layer.provide(ClaudeSdkLive),
  );
