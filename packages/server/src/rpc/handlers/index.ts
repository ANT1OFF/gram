import * as Layer from "effect/Layer";
import { AgentRuntimeHandlersLive } from "../../agent-runtime/handler.ts";
import { DreamHandlersLive } from "../../orchestration/dream-handler.ts";
import { OrchestrationHandlersLive } from "../../orchestration/handler.ts";
import { AppHandlersLive } from "./app-layer.ts";
import { ConnectorHandlersLive } from "./connectors.ts";
import { ComposerHandlersLive } from "./composer-layer.ts";
import { FileHandlersLive } from "./fs.ts";
import { GitHandlersLive } from "./git.ts";
import { ProjectHandlersLive } from "./projects.ts";
import { SettingsHandlersLive } from "./settings.ts";
import { TerminalHandlersLive } from "./terminal.ts";
import { ThreadHandlersLive } from "./threads-layer.ts";

/**
 * Every domain group's handler layer. `RpcServer.layer(GramRpcs)` demands a handler for
 * every RPC, so a group left out of here fails the typecheck; a contract-only PR serves its new
 * RPCs with `notImplemented` in its own group's handlers.
 */
export const RpcHandlersLayer = Layer.mergeAll(
  AgentRuntimeHandlersLive,
  AppHandlersLive,
  ComposerHandlersLive,
  ConnectorHandlersLive,
  DreamHandlersLive,
  FileHandlersLive,
  GitHandlersLive,
  OrchestrationHandlersLive,
  ProjectHandlersLive,
  SettingsHandlersLive,
  TerminalHandlersLive,
  ThreadHandlersLive,
);
