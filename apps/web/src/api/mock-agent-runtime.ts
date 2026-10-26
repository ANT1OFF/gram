import {
  CliUpdateRefused,
  RuntimeInstallRefused,
  type AgentRuntime,
  type AgentRuntimes,
  type CliUpdateState,
  type ManagedInstall,
  type RuntimeAgent,
  type RuntimeInstallState,
  type RuntimeSourceChoice,
  type ThreadStatus,
  type ThreadSummary,
} from "@gram/contracts";
import { isOlderVersion } from "@/launch-checks/issues";

import { createChannel, type Channel } from "./channel";
import { recordUpdatedCli, updatedClis } from "./mock-launch-checks";

/** e2e specs put a partial `AgentRuntimes` here (sessionStorage) to simulate other machines. */
export const MOCK_AGENT_RUNTIMES_KEY = "gram.mock.agentRuntimes";

const DAY = 86_400_000;
const SHA = "0".repeat(64);

const agents = (now: number): AgentRuntime[] => [
  {
    agent: "claude",
    resolved: { source: "path", path: "/mock/bin/claude", version: "2.1.284" },
    baseline: { cliVersion: "2.1.284", binding: "claude-agent-sdk", bindingVersion: "0.3.284" },
    verdict: "supported",
    installSteps: [{ installer: "native", command: "claude update", exact: false }],
  },
  {
    agent: "codex",
    resolved: { source: "path", path: "/mock/bin/codex", version: "0.159.2" },
    baseline: {
      cliVersion: "0.159.2",
      binding: "codex-protocol",
      bindingVersion: "0.159.2",
    },
    verdict: "supported",
    newer: {
      version: "0.159.4",
      channel: "stable",
      publishedAt: now - 2 * DAY,
      eligibleAt: now - DAY,
      eligible: true,
      verdict: "supported",
    },
    installSteps: [
      {
        installer: "npm",
        command: "npm i -g @openai/codex@0.159.4",
        exact: true,
        version: "0.159.4",
      },
    ],
    managed: { candidate: { version: "0.159.4", channel: "stable" } },
  },
];

/** Every agent installed at its baseline, Codex with a newer one out, unless a spec stored more. */
export function mockAgentRuntimes(now = Date.now()): AgentRuntimes {
  let override: Partial<AgentRuntimes> = {};
  try {
    const saved =
      typeof sessionStorage === "undefined"
        ? null
        : sessionStorage.getItem(MOCK_AGENT_RUNTIMES_KEY);
    if (saved) override = JSON.parse(saved) as Partial<AgentRuntimes>;
  } catch {
    // A malformed override keeps the defaults.
  }
  return { agents: agents(now), releasesCheckedAt: now, ...override, checkedAt: now };
}

/** Steps of a simulated install, as fractions of the download. */
const STEPS = [0, 0.4, 0.8, 1];
const STEP_MS = 150;

/** The managed store, for Codex only, installing in a few quick steps. */
export class MockAgentRuntime {
  #state: RuntimeInstallState = { state: "idle" };
  #source: RuntimeSourceChoice = "path";
  readonly #watchers = new Set<Channel<RuntimeInstallState>>();
  #timer: ReturnType<typeof setTimeout> | undefined;

  get source(): RuntimeSourceChoice {
    return this.#source;
  }

  /**
   * `listing` as this store changes it: it offers no candidate it already has, and once the user
   * chooses the store, Codex's row resolves there. Installing alone leaves their own codex in use.
   */
  applyTo(listing: AgentRuntimes): AgentRuntimes {
    const active = this.#state.active;
    if (active === undefined) return listing;
    return {
      ...listing,
      agents: listing.agents.map((runtime) => {
        if (runtime.agent !== "codex") return runtime;
        const { candidate } = runtime.managed ?? {};
        const offer =
          candidate === undefined || candidate.version === active.version ? {} : { candidate };
        if (this.#source !== "managed") return { ...runtime, managed: offer };
        const { newer, ...rest } = runtime;
        return {
          ...rest,
          resolved: { source: "managed", path: active.path, version: active.version },
          ...(newer !== undefined && isOlderVersion(active.version, newer.version)
            ? { newer }
            : {}),
          installSteps: [],
          managed: offer,
        };
      }),
    };
  }

  #served(agent: RuntimeAgent): void {
    if (agent !== "codex")
      throw new RuntimeInstallRefused({
        agent,
        reason: "unsupported",
        message: "Gram doesn't manage this agent's CLI yet.",
      });
  }

  #set(state: RuntimeInstallState): RuntimeInstallState {
    this.#state = state;
    for (const watcher of this.#watchers) watcher.push(state);
    return state;
  }

  #settled() {
    const { active, previous } = this.#state;
    return {
      ...(active === undefined ? {} : { active }),
      ...(previous === undefined ? {} : { previous }),
    };
  }

  async state(agent: RuntimeAgent): Promise<RuntimeInstallState> {
    this.#served(agent);
    return this.#state;
  }

  watch(agent: RuntimeAgent, signal: AbortSignal): AsyncIterable<RuntimeInstallState> {
    this.#served(agent);
    const channel = createChannel<RuntimeInstallState>(signal, () => {
      this.#watchers.delete(channel);
    });
    this.#watchers.add(channel);
    channel.push(this.#state);
    return channel;
  }

  async install(agent: RuntimeAgent, version: string): Promise<RuntimeInstallState> {
    this.#served(agent);
    if (this.#timer !== undefined)
      throw new RuntimeInstallRefused({ agent, reason: "busy", message: "Already installing." });
    const total = 52_000_000;
    const settled = this.#settled();
    const step = (index: number) => {
      if (index < STEPS.length) {
        this.#set({
          state: "downloading",
          version,
          receivedBytes: Math.round(total * STEPS[index]!),
          totalBytes: total,
          ...settled,
        });
        this.#timer = setTimeout(() => step(index + 1), STEP_MS);
        return;
      }
      this.#set({ state: "verifying", version, ...settled });
      this.#timer = setTimeout(() => {
        this.#set({ state: "testing", version, ...settled });
        this.#timer = setTimeout(finish, STEP_MS);
      }, STEP_MS);
    };
    const finish = () => {
      this.#timer = undefined;
      const installed: ManagedInstall = {
        version,
        sha256: SHA,
        path: `/mock/store/codex/${version}/codex`,
        installedAt: Date.now(),
      };
      this.#set({
        state: "idle",
        active: installed,
        ...(settled.active === undefined ? {} : { previous: settled.active }),
      });
    };
    step(0);
    return this.#state;
  }

  async cancel(agent: RuntimeAgent): Promise<RuntimeInstallState> {
    this.#served(agent);
    clearTimeout(this.#timer);
    this.#timer = undefined;
    return this.#set({ state: "idle", ...this.#settled() });
  }

  async rollback(agent: RuntimeAgent): Promise<RuntimeInstallState> {
    this.#served(agent);
    if (this.#timer !== undefined)
      throw new RuntimeInstallRefused({
        agent,
        reason: "busy",
        message: "An install is under way.",
      });
    const { active, previous } = this.#state;
    if (previous === undefined)
      throw new RuntimeInstallRefused({
        agent,
        reason: "nothing-to-roll-back",
        message: "There is no earlier version to go back to.",
      });
    return this.#set({ state: "idle", active: previous, ...(active ? { previous: active } : {}) });
  }

  async useSource(agent: RuntimeAgent, source: RuntimeSourceChoice): Promise<void> {
    this.#served(agent);
    this.#source = source;
  }
}

/** A thread in one of these has a live session, which keeps the CLI it started with. */
const LIVE: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "idle",
  "running",
  "needsApproval",
  "needsInput",
]);

/**
 * Updates of the user's own CLIs, run in a few lines of output each; afterwards the launch checks
 * and the agent's row report the version the step installed, until the session ends. `fail` makes the next run fail as a refused sign-in would.
 */
export class MockCliUpdates {
  /** The pause between output lines; a spec slows it to look at a running update. */
  stepMs = 150;
  /** The next run fails like npm with an expired npm registry token. */
  fail = false;
  readonly #states = new Map<RuntimeAgent, CliUpdateState>();
  readonly #watchers = new Map<RuntimeAgent, Set<Channel<CliUpdateState>>>();
  readonly #timers = new Map<RuntimeAgent, ReturnType<typeof setTimeout>>();

  readonly #threads: () => readonly ThreadSummary[];

  constructor(threads: () => readonly ThreadSummary[]) {
    this.#threads = threads;
  }

  /** `listing` with each updated CLI at its new version, its steps and older release gone. */
  applyTo(listing: AgentRuntimes): AgentRuntimes {
    return {
      ...listing,
      agents: listing.agents.map((runtime) => {
        const version = updatedClis()[runtime.agent];
        if (version === undefined || runtime.resolved?.source !== "path") return runtime;
        const { newer, reason: _reason, ...rest } = runtime;
        return {
          ...rest,
          resolved: { ...runtime.resolved, version },
          verdict: "supported",
          ...(newer !== undefined && isOlderVersion(version, newer.version) ? { newer } : {}),
          installSteps: [],
        };
      }),
    };
  }

  #state(agent: RuntimeAgent): CliUpdateState {
    return this.#states.get(agent) ?? { state: "idle" };
  }

  #set(agent: RuntimeAgent, state: CliUpdateState): CliUpdateState {
    this.#states.set(agent, state);
    for (const watcher of this.#watchers.get(agent) ?? []) watcher.push(state);
    return state;
  }

  watch(agent: RuntimeAgent, signal: AbortSignal): AsyncIterable<CliUpdateState> {
    const watchers = this.#watchers.get(agent) ?? new Set();
    this.#watchers.set(agent, watchers);
    const channel = createChannel<CliUpdateState>(signal, () => {
      watchers.delete(channel);
    });
    watchers.add(channel);
    channel.push(this.#state(agent));
    return channel;
  }

  async start(
    agent: RuntimeAgent,
    command: string,
    listing: AgentRuntimes,
  ): Promise<CliUpdateState> {
    if (this.#state(agent).state === "running")
      throw new CliUpdateRefused({ agent, reason: "busy", message: "Already updating." });
    const runtime = listing.agents.find((row) => row.agent === agent);
    const step = runtime?.installSteps.find((s) => s.command === command && s.run !== undefined);
    if (runtime === undefined || step === undefined)
      throw new CliUpdateRefused({
        agent,
        reason: "not-offered",
        message: "Gram doesn't offer to run that now.",
      });
    const runningThreads = this.#threads().filter(
      (t) => t.thread.model.agent === agent && LIVE.has(t.status),
    ).length;
    const from = runtime.resolved?.version;
    const target = step.version ?? runtime.newer?.version;
    const failing = this.fail;
    this.fail = false;
    const lines = failing
      ? ["npm error code E401", "npm error 401 Unauthorized - GET https://registry.mock/x"]
      : [
          `Checking for ${command.split(" ")[0]} updates…`,
          `Downloading ${target ?? "the latest release"}`,
          `Installed ${target ?? "the latest release"}`,
        ];
    const running = this.#set(agent, {
      state: "running",
      command,
      output: "",
      startedAt: Date.now(),
      runningThreads,
    });
    const print = (index: number, output: string) => {
      if (index < lines.length) {
        const next = `${output}${lines[index]!}\n`;
        this.#set(agent, { ...running, output: next } as CliUpdateState);
        this.#timers.set(
          agent,
          setTimeout(() => print(index + 1, next), this.stepMs),
        );
        return;
      }
      this.#timers.delete(agent);
      if (failing) {
        this.#set(agent, {
          state: "failed",
          command,
          output,
          problem: "sign-in",
          message: "npm registry sign-in expired: run npm login, then try again.",
        });
        return;
      }
      if (target !== undefined) recordUpdatedCli(agent, target);
      this.#set(agent, {
        state: "succeeded",
        command,
        output,
        ...(from === undefined ? {} : { from }),
        ...(target === undefined ? {} : { version: target }),
        runningThreads,
      });
    };
    this.#timers.set(
      agent,
      setTimeout(() => print(0, ""), this.stepMs),
    );
    return running;
  }

  async cancel(agent: RuntimeAgent): Promise<CliUpdateState> {
    const now = this.#state(agent);
    clearTimeout(this.#timers.get(agent));
    this.#timers.delete(agent);
    if (now.state === "running")
      return this.#set(agent, {
        state: "failed",
        command: now.command,
        output: now.output,
        problem: "cancelled",
        message:
          "Cancelled. It may have stopped part-way; run it again, or run it yourself in a terminal.",
      });
    return this.#set(agent, { state: "idle" });
  }
}
