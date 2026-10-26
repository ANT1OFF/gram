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
  /**
   * Each agent's resolved CLI, its verdict against the shipped bindings and any newer release.
   * Read-only: it runs `--version` and nothing that starts a server. Cached; `refresh` probes the
   * machine again and reads vendor releases only if they are stale.
   */
  Rpc.make("agentRuntime.list", {
    payload: { refresh: Schema.optionalKey(Schema.Boolean) },
    success: AgentRuntimes,
    error: errors(),
  }),
  /** The agent's managed store: what is active, and any install under way. */
  Rpc.make("agentRuntime.installState", {
    payload: { agent: RuntimeAgent },
    success: RuntimeInstallState,
    error: errors(RuntimeInstallRefused),
  }),
  /** The managed store's state now and on each change, progress included. */
  Rpc.make("agentRuntime.watchInstall", {
    payload: { agent: RuntimeAgent },
    success: RuntimeInstallState,
    error: errors(RuntimeInstallRefused),
    stream: true,
  }),
  /**
   * Downloads, verifies and records an exact approved version into the managed store, activating it
   * once the agent is idle; answers with the state it started in. The server checks the approval,
   * the 24-hour age and the artifact again itself, whatever the client showed.
   */
  Rpc.make("agentRuntime.install", {
    payload: RuntimeInstallPayload,
    success: RuntimeInstallState,
    error: errors(RuntimeInstallRefused, FsError),
  }),
  /** Stops an install before it activates; the active runtime stays. */
  Rpc.make("agentRuntime.cancel", {
    payload: { agent: RuntimeAgent },
    success: RuntimeInstallState,
    error: errors(RuntimeInstallRefused),
  }),
  /** Makes the previous healthy managed runtime active again, once the agent is idle. */
  Rpc.make("agentRuntime.rollback", {
    payload: { agent: RuntimeAgent },
    success: RuntimeInstallState,
    error: errors(RuntimeInstallRefused, FsError),
  }),
  /** Whether new sessions of the agent start from the managed store or the user's own install. */
  Rpc.make("agentRuntime.useSource", {
    payload: { agent: RuntimeAgent, source: RuntimeSourceChoice },
    error: errors(RuntimeInstallRefused),
  }),
  /**
   * Runs an install step that carries `run` on the user's own CLI, with their login-shell PATH and
   * their package manager's own configuration, then probes the CLI again; answers with the state it
   * started in. Unrelated to the managed store. The server matches `command` against its current
   * listing itself, so it runs only what it offers, whatever the client sent.
   */
  Rpc.make("agentRuntime.update", {
    payload: CliUpdatePayload,
    success: CliUpdateState,
    error: errors(CliUpdateRefused),
  }),
  /** The update of the user's own CLI now and on each change, output included. */
  Rpc.make("agentRuntime.watchUpdate", {
    payload: { agent: RuntimeAgent },
    success: CliUpdateState,
    error: errors(),
    stream: true,
  }),
  /** Stops a running update of the user's own CLI, or clears a finished one's outcome. */
  Rpc.make("agentRuntime.cancelUpdate", {
    payload: { agent: RuntimeAgent },
    success: CliUpdateState,
    error: errors(),
  }),
);
