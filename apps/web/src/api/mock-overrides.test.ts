// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockApi } from "./mock";
import { MOCK_AGENTS_KEY, mockAgents } from "./mock-overrides";

const supported = ["claude", "codex"] as const;
type Supported = (typeof supported)[number];
const cases: Array<{
  name: string;
  flag: string | null;
  agents: readonly Supported[] | undefined;
  available: readonly Supported[];
}> = [
  { name: "absent", flag: null, agents: undefined, available: ["claude"] },
  { name: "empty", flag: "", agents: [], available: [] },
  { name: "unknown-only", flag: "invented-unknown", agents: [], available: [] },
  { name: "Claude only", flag: "claude", agents: ["claude"], available: ["claude"] },
  { name: "Codex only", flag: "codex", agents: ["codex"], available: ["codex"] },
  { name: "both supported", flag: "codex,claude", agents: supported, available: supported },
  {
    name: "mixed Codex/unknown",
    flag: "invented-unknown,codex",
    agents: ["codex"],
    available: ["codex"],
  },
];

beforeEach(() => sessionStorage.clear());
afterEach(() => sessionStorage.clear());

describe("explicit mock adapter fixtures", () => {
  it.each(cases)(
    "$name flag preserves availability without manufacturing adapters",
    async ({ flag, agents, available }) => {
      if (flag !== null) sessionStorage.setItem(MOCK_AGENTS_KEY, flag);
      expect(mockAgents()).toEqual(agents);
      const api = createMockApi({ speed: 0, autoplay: false });
      for (const agent of supported) {
        if (available.includes(agent)) {
          expect((await api.listModels(agent)).models.length).toBeGreaterThan(0);
        } else {
          await expect(api.listModels(agent)).rejects.toMatchObject({
            _tag: "AgentUnavailable",
            agent,
          });
        }
      }
    },
  );

  it("an explicit empty adapter option overrides the absent-flag defaults", async () => {
    expect(mockAgents()).toBeUndefined();
    const api = createMockApi({ speed: 0, autoplay: false, agents: [] });
    for (const agent of supported) {
      await expect(api.listModels(agent)).rejects.toMatchObject({
        _tag: "AgentUnavailable",
        agent,
      });
    }
  });
});
