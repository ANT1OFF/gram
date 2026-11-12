import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SETTINGS, type Settings, type ThreadId } from "@gram/contracts";

import { browserStatus } from "./browser-status.ts";

const allOn: Settings = {
  ...DEFAULT_SETTINGS,
  agents: { ...DEFAULT_SETTINGS.agents, claudeInChrome: true, codexComputerUse: true },
  workspaces: { orchestratorBrowser: true, workerBrowser: true },
};
const codex = { model: { agent: "codex" as const, model: "gpt" } };
const claude = { model: { agent: "claude" as const, model: "opus" } };
const worker = { spawnedBy: { threadId: "t-orch" as ThreadId, feature: "f" }, browser: true };
/** What the session policy grants once every consent is on. */
const granted = { browser: true };

describe("browserStatus", () => {
  it("never says on for a Codex orchestrator in Gram's own Codex home (the reviewer's case)", () => {
    expect(
      browserStatus({ ...codex, role: "orchestrator", codexHome: "owned" }, allOn, {
        ...granted,
        outwardGate: "all",
      }),
    ).toMatchObject({ state: "unavailable", why: expect.stringContaining("Gram's own") });
  });

  for (const outwardGate of ["all", "irreversible"] as const)
    it(`says not available for a new Codex worker under the ${outwardGate} gate`, () => {
      expect(
        browserStatus({ ...codex, ...worker }, allOn, { ...granted, outwardGate }),
      ).toMatchObject({ state: "unavailable" });
    });

  it("keeps a Codex thread that started gated unavailable after its workspace is ungated", () => {
    expect(
      browserStatus({ ...codex, ...worker, codexHome: "owned", agentSessionId: "s" }, allOn, {
        ...granted,
        outwardGate: undefined,
      }),
    ).toMatchObject({ state: "unavailable" });
    // One in the user's own home has it once ungated.
    expect(
      browserStatus({ ...codex, ...worker, codexHome: "user", agentSessionId: "s" }, allOn, {
        ...granted,
        outwardGate: undefined,
      }),
    ).toEqual({ state: "on" });
  });

  it("says not available on a gateway and for a profile's thread, whichever agent", () => {
    const gateway = { agent: "claude" as const, model: "opus", profileId: "p" as never };
    expect(
      browserStatus({ model: gateway, browser: true }, allOn, {
        ...granted,
        outwardGate: undefined,
      }),
    ).toMatchObject({ state: "unavailable", why: expect.stringContaining("gateway") });
    expect(
      browserStatus({ ...claude, browser: true, profile: {} as never }, allOn, {
        browser: false,
        outwardGate: undefined,
      }),
    ).toMatchObject({ state: "unavailable", why: expect.stringContaining("profile") });
  });

  it("explains a lend the action would refuse even before it is lent", () => {
    expect(
      browserStatus({ ...codex, codexHome: "owned" }, allOn, { outwardGate: undefined }),
    ).toMatchObject({ state: "off", cannot: expect.stringContaining("Gram's own") });
    expect(browserStatus(claude, allOn, { outwardGate: undefined })).toEqual({ state: "off" });
  });

  it("says held, and which consent, when the grant is lent but not allowed", () => {
    expect(
      browserStatus({ ...claude, browser: true }, DEFAULT_SETTINGS, { outwardGate: undefined }),
    ).toEqual({ state: "held", why: "Claude in Chrome is off in Settings → Agents." });
    expect(
      browserStatus({ ...claude, ...worker }, { ...allOn, workspaces: {} }, { outwardGate: "all" }),
    ).toEqual({ state: "held", why: "Workers' browser is off in Settings → Workspaces." });
    expect(
      browserStatus({ ...claude, ...worker }, allOn, { ...granted, outwardGate: "all" }),
    ).toEqual({ state: "on" });
  });
});
