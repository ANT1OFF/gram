import { DEFAULT_SETTINGS, type Settings, type ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { browserState } from "./browser-chip";

const claude = { model: { agent: "claude" as const, model: "opus" } };
const allowed: Settings = {
  ...DEFAULT_SETTINGS,
  agents: { ...DEFAULT_SETTINGS.agents, claudeInChrome: true },
  workspaces: { orchestratorBrowser: true, workerBrowser: true },
};

describe("browserState", () => {
  it("shows nothing for a thread that wasn't given the browser", () => {
    expect(browserState(claude, allowed)).toBeUndefined();
    expect(browserState({ ...claude, role: "dream", browser: true }, allowed)).toBeUndefined();
    expect(
      browserState({ ...claude, role: "orchestrator" }, { ...allowed, workspaces: {} }),
    ).toBeUndefined();
  });

  it("is on only while every consent it needs is", () => {
    expect(browserState({ ...claude, browser: true }, allowed)).toEqual({ state: "on" });
    expect(browserState({ ...claude, role: "orchestrator" }, allowed)).toEqual({ state: "on" });
    expect(browserState({ ...claude, browser: true }, DEFAULT_SETTINGS)).toEqual({
      state: "held",
      why: "Claude in Chrome is off in Settings → Agents.",
    });
    const worker = {
      ...claude,
      browser: true,
      spawnedBy: { threadId: "t" as ThreadId, feature: "f" },
    };
    expect(browserState(worker, { ...allowed, workspaces: {} })).toEqual({
      state: "held",
      why: "Workers' browser is off in Settings → Workspaces.",
    });
  });
});
