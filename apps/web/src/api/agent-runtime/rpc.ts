import { run, untilGone, iterate, type RpcContext } from "../rpc-client";
import type { AgentRuntimeApi } from "./types";

/** `AgentRuntimeApi` over the RPC client. */
export const agentRuntimeRpc = ({ client, connection }: RpcContext): AgentRuntimeApi => ({
  agentRuntimes: (refresh) =>
    run(client["agentRuntime.list"](refresh === undefined ? {} : { refresh })),
  runtimeInstallState: (agent) => run(client["agentRuntime.installState"]({ agent })),
  watchRuntimeInstall: (agent, signal) =>
    untilGone(
      (s) => iterate(client["agentRuntime.watchInstall"]({ agent }), s),
      connection,
      signal,
      // A refusal (an agent the store doesn't serve) stays a refusal on every retry.
      (error) => (error as { _tag?: unknown } | null)?._tag === "RuntimeInstallRefused",
    ),
  installRuntime: (agent, version) => run(client["agentRuntime.install"]({ agent, version })),
  cancelRuntimeInstall: (agent) => run(client["agentRuntime.cancel"]({ agent })),
  rollbackRuntime: (agent) => run(client["agentRuntime.rollback"]({ agent })),
  setRuntimeSource: (agent, source) => run(client["agentRuntime.useSource"]({ agent, source })),
  updateCli: (agent, command) => run(client["agentRuntime.update"]({ agent, command })),
  watchCliUpdate: (agent, signal) =>
    untilGone((s) => iterate(client["agentRuntime.watchUpdate"]({ agent }), s), connection, signal),
  cancelCliUpdate: (agent) => run(client["agentRuntime.cancelUpdate"]({ agent })),
});
