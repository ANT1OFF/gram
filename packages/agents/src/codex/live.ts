import * as Layer from "effect/Layer";
import type { GatewayKeyProvider } from "../gateway.ts";
import { CodexServersLive, type CodexServersConfig } from "./servers.ts";
import { CodexHostLayer, type CodexHost, type CodexHostConfig } from "./session.ts";

export interface CodexHostLiveConfig extends CodexHostConfig {
  readonly servers?: CodexServersConfig;
}

/** `CodexHost` backed by the user's installed `codex`, one app-server per credential set. */
export const CodexHostLive = (
  config: CodexHostLiveConfig = {},
): Layer.Layer<CodexHost, never, GatewayKeyProvider> =>
  CodexHostLayer({ ...config, helperServers: config.servers ?? config.helperServers ?? {} }).pipe(
    Layer.provideMerge(CodexServersLive(config.servers)),
  );
