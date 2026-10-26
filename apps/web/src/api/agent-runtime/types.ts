import type {
  AgentRuntimes,
  CliUpdateState,
  RuntimeAgent,
  RuntimeInstallState,
  RuntimeSourceChoice,
} from "@gram/contracts";

/** `agentRuntime.*`: which agent CLI install each thread runs, and Gram's managed store. */
export interface AgentRuntimeApi {
  /**
   * Each agent CLI's source, version, verdict and newer release. Read-only; cached unless
   * `refresh`, which still reads vendor releases only once they are stale.
   */
  agentRuntimes(refresh?: boolean): Promise<AgentRuntimes>;
  /** The agent's managed store. Rejects with `RuntimeInstallRefused` where it doesn't apply. */
  runtimeInstallState(agent: RuntimeAgent): Promise<RuntimeInstallState>;
  /** The managed store's state now and on each change, until `signal` aborts. */
  watchRuntimeInstall(agent: RuntimeAgent, signal: AbortSignal): AsyncIterable<RuntimeInstallState>;
  /**
   * Installs an exact version into the managed store, activating it once the agent is idle.
   * Rejects with `RuntimeInstallRefused` saying why (too fresh, not qualified, unverified, busy).
   */
  installRuntime(agent: RuntimeAgent, version: string): Promise<RuntimeInstallState>;
  cancelRuntimeInstall(agent: RuntimeAgent): Promise<RuntimeInstallState>;
  /** Back to the previous healthy managed runtime. */
  rollbackRuntime(agent: RuntimeAgent): Promise<RuntimeInstallState>;
  /** Whether the agent's new sessions start from the managed store or the user's own install. */
  setRuntimeSource(agent: RuntimeAgent, source: RuntimeSourceChoice): Promise<void>;
  /**
   * Runs an install step that carries `run` on the user's own CLI, then probes it again. Rejects
   * with `CliUpdateRefused` when one is already running or the step isn't offered any more.
   */
  updateCli(agent: RuntimeAgent, command: string): Promise<CliUpdateState>;
  /** The update of the user's own CLI now and on each change, output included, until `signal`. */
  watchCliUpdate(agent: RuntimeAgent, signal: AbortSignal): AsyncIterable<CliUpdateState>;
  /** Stops a running update, or clears a finished one's outcome. */
  cancelCliUpdate(agent: RuntimeAgent): Promise<CliUpdateState>;
}
