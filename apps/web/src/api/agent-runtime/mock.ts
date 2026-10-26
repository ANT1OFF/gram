import { MockAgentRuntime, MockCliUpdates, mockAgentRuntimes } from "../mock-agent-runtime";
import type { MockWorld } from "../mock-world";
import type { AgentRuntimeApi } from "./types";

/**
 * `AgentRuntimeApi` over `MockAgentRuntime` and `MockCliUpdates`, which specs drive through
 * `agentRuntime` and `cliUpdates`.
 */
export function createAgentRuntimeMock(world: MockWorld) {
  /** The managed store; specs reach it through `window.gramMock`. */
  const agentRuntime = new MockAgentRuntime();
  /** Updates of the user's own CLIs; specs reach it through `window.gramMock`. */
  const cliUpdates = new MockCliUpdates(() => world.threads());
  const listing = () => cliUpdates.applyTo(agentRuntime.applyTo(mockAgentRuntimes()));
  return {
    agentRuntime,
    cliUpdates,
    agentRuntimes: async () => listing(),
    runtimeInstallState: (agent) => agentRuntime.state(agent),
    watchRuntimeInstall: (agent, signal) => agentRuntime.watch(agent, signal),
    installRuntime: (agent, version) => agentRuntime.install(agent, version),
    cancelRuntimeInstall: (agent) => agentRuntime.cancel(agent),
    rollbackRuntime: (agent) => agentRuntime.rollback(agent),
    setRuntimeSource: async (agent, source) => {
      await agentRuntime.useSource(agent, source);
      // Like the server, which keeps the choice in Settings.
      await world.setCodexRuntime(source);
    },
    updateCli: (agent, command) => cliUpdates.start(agent, command, listing()),
    watchCliUpdate: (agent, signal) => cliUpdates.watch(agent, signal),
    cancelCliUpdate: (agent) => cliUpdates.cancel(agent),
  } satisfies AgentRuntimeApi & { agentRuntime: MockAgentRuntime; cliUpdates: MockCliUpdates };
}
