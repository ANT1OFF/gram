// The wire surface, assembled: each domain declares its RPCs in `rpc/<domain>.ts`, and this module
// only merges them. Nothing here declares an RPC or a shape, so no domain imports back from it.
import * as RpcGroup from "effect/rpc/RpcGroup";
import { AgentRuntimeRpcs } from "./rpc/agent-runtime.ts";
import { AppRpcs } from "./rpc/app.ts";
import { ComposerRpcs } from "./rpc/composer.ts";
import { ConnectorRpcs } from "./rpc/connectors.ts";
import { DreamRpcs } from "./rpc/dreams.ts";
import { FileRpcs } from "./rpc/files.ts";
import { GitRpcs } from "./rpc/git.ts";
import { OrchestrationRpcs } from "./rpc/orchestration.ts";
import { ProjectRpcs } from "./rpc/projects.ts";
import { SettingsRpcs } from "./rpc/settings.ts";
import { TerminalRpcs } from "./rpc/terminal.ts";
import { ThreadRpcs } from "./rpc/threads.ts";

/**
 * Every domain's group. A tag belongs to exactly one: `merge` keeps the last of two RPCs with the
 * same tag, so a test checks that none is shared.
 */
// Annotated, not inferred: the merged surface is past what the declaration emitter will spell out
// in full (TS7056), so its type names each domain's group instead.
export const GramRpcGroups: readonly [
  typeof AgentRuntimeRpcs,
  typeof AppRpcs,
  typeof ComposerRpcs,
  typeof ConnectorRpcs,
  typeof DreamRpcs,
  typeof FileRpcs,
  typeof GitRpcs,
  typeof OrchestrationRpcs,
  typeof ProjectRpcs,
  typeof SettingsRpcs,
  typeof TerminalRpcs,
  typeof ThreadRpcs,
] = [
  AgentRuntimeRpcs,
  AppRpcs,
  ComposerRpcs,
  ConnectorRpcs,
  DreamRpcs,
  FileRpcs,
  GitRpcs,
  OrchestrationRpcs,
  ProjectRpcs,
  SettingsRpcs,
  TerminalRpcs,
  ThreadRpcs,
];

/** The whole wire surface, served over one WebSocket: every domain's group, merged. */
export const GramRpcs: RpcGroup.RpcGroup<RpcGroup.Rpcs<(typeof GramRpcGroups)[number]>> =
  RpcGroup.make().merge(...GramRpcGroups);
export type GramRpcs = typeof GramRpcs;

export * from "./rpc/agent-runtime.ts";
export * from "./rpc/app.ts";
export * from "./rpc/composer.ts";
export * from "./rpc/connectors.ts";
export * from "./rpc/dreams.ts";
export * from "./rpc/files.ts";
export * from "./rpc/git.ts";
export * from "./rpc/orchestration.ts";
export * from "./rpc/projects.ts";
export * from "./rpc/settings.ts";
export * from "./rpc/terminal.ts";
export * from "./rpc/threads.ts";
