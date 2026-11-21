import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import {
  AgentRuntimes,
  CliUpdatePayload,
  CliUpdateRefused,
  CliUpdateState,
  RuntimeAgent,
  RuntimeInstallPayload,
  RuntimeInstallRefused,
  RuntimeInstallState,
  RuntimeSourceChoice,
} from "../agent-runtime.ts";
import { FsError } from "../errors.ts";
import { errors } from "./shared.ts";

/** The agent CLIs: which install each thread runs, and Gram's managed store of them. */
export const AgentRuntimeRpcs = RpcGroup.make(
  Rpc.make("agentRuntime.list", {
    payload: { refresh: Schema.optionalKey(Schema.Boolean) },
    success: AgentRuntimes,
    error: errors(),
  }),
  Rpc.make("agentRuntime.installState", {
    payload: { agent: RuntimeAgent },
    success: RuntimeInstallState,
    error: errors(RuntimeInstallRefused),
  }),
  Rpc.make("agentRuntime.watchInstall", {
    payload: { agent: RuntimeAgent },
    success: RuntimeInstallState,
    error: errors(RuntimeInstallRefused),
    stream: true,
  }),
  Rpc.make("agentRuntime.install", {
    payload: RuntimeInstallPayload,
    success: RuntimeInstallState,
    error: errors(RuntimeInstallRefused, FsError),
  }),
  Rpc.make("agentRuntime.cancel", {
    payload: { agent: RuntimeAgent },
    success: RuntimeInstallState,
    error: errors(RuntimeInstallRefused),
  }),
  Rpc.make("agentRuntime.rollback", {
    payload: { agent: RuntimeAgent },
    success: RuntimeInstallState,
    error: errors(RuntimeInstallRefused, FsError),
  }),
  Rpc.make("agentRuntime.useSource", {
    payload: { agent: RuntimeAgent, source: RuntimeSourceChoice },
    error: errors(RuntimeInstallRefused),
  }),
  Rpc.make("agentRuntime.update", {
    payload: CliUpdatePayload,
    success: CliUpdateState,
    error: errors(CliUpdateRefused),
  }),
  Rpc.make("agentRuntime.watchUpdate", {
    payload: { agent: RuntimeAgent },
    success: CliUpdateState,
    error: errors(),
    stream: true,
  }),
  Rpc.make("agentRuntime.cancelUpdate", {
    payload: { agent: RuntimeAgent },
    success: CliUpdateState,
    error: errors(),
  }),
);
