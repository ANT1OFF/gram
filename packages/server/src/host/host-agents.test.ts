import type { AgentHost } from "@gram/agents";
import type { AgentKind } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { hostAgentsFrom, limitedAgentHosts } from "./host-agents.ts";

const host = (kind: AgentKind) => ({ kind }) as unknown as AgentHost;
const every = AgentHosts.fromHosts(
  (["claude", "codex", "opencode", "grok", "antigravity"] as const).map(host),
);
const runs = (agents: AgentHosts["Service"], agent: AgentKind) =>
  Effect.runPromise(
    agents.get(agent).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ),
  );

describe("a host limited to some agents", () => {
  it("runs only the agents it is named for, and every agent when it names none", async () => {
    const limited = limitedAgentHosts(every, hostAgentsFrom(" Claude, nonsense ,").only);
    expect(await runs(limited, "claude")).toBe(true);
    for (const agent of ["codex", "opencode", "grok", "antigravity"] as const)
      expect(await runs(limited, agent)).toBe(false);
    expect(hostAgentsFrom(" Claude, nonsense ,").ignored).toEqual(["nonsense"]);

    for (const value of [undefined, "", " , ", "nonsense"]) {
      const unlimited = limitedAgentHosts(every, hostAgentsFrom(value).only);
      for (const agent of ["claude", "codex", "opencode", "grok", "antigravity"] as const)
        expect(await runs(unlimited, agent)).toBe(true);
    }
  });
});
