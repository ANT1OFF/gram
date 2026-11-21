import { AgentKind, AgentUnavailable } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AgentHosts } from "../runtime/agent-hosts.ts";

/** The variable that limits a joined machine's host to some of the agents (`hostAgentsFrom`). */
export const HOST_AGENTS_ENV = "GRAM_HOST_AGENTS";

const isAgentKind = Schema.is(AgentKind);

/**
 * The agents `value` (`GRAM_HOST_AGENTS`, a comma-separated list such as `claude` or
 * `claude,codex`) limits a host to, with the names in it that are no agent, which are left out.
 * Unset, empty, or naming no agent: every agent, as a host runs without it.
 */
export const hostAgentsFrom = (
  value: string | undefined,
): {
  readonly only: ReadonlySet<AgentKind> | undefined;
  readonly ignored: ReadonlyArray<string>;
} => {
  const names = (value ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  const known = names.filter(isAgentKind);
  return {
    only: known.length === 0 ? undefined : new Set(known),
    ignored: names.filter((name) => !isAgentKind(name)),
  };
};

/**
 * `agents` with every agent `only` leaves out refused, as one the host doesn't run: the host then
 * starts none of that agent's CLI (its status lists it nowhere, as it names no Codex or OpenCode
 * it can't run), and its hello offers none of its sessions. A machine that runs one agent's
 * threads, started for them, comes up without the others' CLIs taking its CPU.
 */
export const limitedAgentHosts = (
  agents: AgentHosts["Service"],
  only: ReadonlySet<AgentKind> | undefined,
): AgentHosts["Service"] =>
  only === undefined
    ? agents
    : {
        ...agents,
        get: (agent) =>
          only.has(agent)
            ? agents.get(agent)
            : Effect.fail(
                new AgentUnavailable({
                  agent,
                  message: `${agent} sessions don't run on this machine: its host runs only ${[...only].join(", ")} (${HOST_AGENTS_ENV}).`,
                }),
              ),
      };
