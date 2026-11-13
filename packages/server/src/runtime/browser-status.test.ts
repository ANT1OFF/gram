import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SETTINGS, type Settings, type ThreadId } from "@gram/contracts";

import { browserNotReady, browserStatus } from "./browser-status.ts";

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
      browserStatus(
        { ...codex, role: "orchestrator" },
        allOn,
        { ...granted, outwardGate: "all" },
        { codexHome: "owned", resumeId: "s" },
      ),
    ).toMatchObject({ state: "unavailable", why: expect.stringContaining("Gram's own") });
  });

  for (const outwardGate of ["all", "irreversible"] as const)
    it(`says not available for a new Codex worker under the ${outwardGate} gate`, () => {
      expect(
        browserStatus({ ...codex, ...worker }, allOn, { ...granted, outwardGate }, {}),
      ).toMatchObject({ state: "unavailable" });
    });

  it("keeps a Codex thread that started gated unavailable after its workspace is ungated", () => {
    expect(
      browserStatus(
        { ...codex, ...worker },
        allOn,
        { ...granted, outwardGate: undefined },
        { codexHome: "owned", resumeId: "s" },
      ),
    ).toMatchObject({ state: "unavailable" });
    // One in the user's own home has it once ungated.
    expect(
      browserStatus(
        { ...codex, ...worker },
        allOn,
        { ...granted, outwardGate: undefined },
        { codexHome: "user", resumeId: "s" },
      ),
    ).toEqual({ state: "on" });
  });

  it("says not available on a gateway and for a profile's thread, whichever agent", () => {
    const gateway = { agent: "claude" as const, model: "opus", profileId: "p" as never };
    expect(
      browserStatus(
        { model: gateway, browser: true },
        allOn,
        { ...granted, outwardGate: undefined },
        {},
      ),
    ).toMatchObject({ state: "unavailable", why: expect.stringContaining("gateway") });
    expect(
      browserStatus(
        { ...claude, browser: true, profile: {} as never },
        allOn,
        { browser: false, outwardGate: undefined },
        {},
      ),
    ).toMatchObject({ state: "unavailable", why: expect.stringContaining("profile") });
  });

  it("explains a lend the action would refuse even before it is lent", () => {
    expect(
      browserStatus(codex, allOn, { outwardGate: undefined }, { codexHome: "owned" }),
    ).toMatchObject({ state: "off", cannot: expect.stringContaining("Gram's own") });
    expect(browserStatus(claude, allOn, { outwardGate: undefined }, {})).toEqual({ state: "off" });
  });

  it("says held, and which consent, when the grant is lent but not allowed", () => {
    expect(
      browserStatus({ ...claude, browser: true }, DEFAULT_SETTINGS, { outwardGate: undefined }, {}),
    ).toEqual({ state: "held", why: "Claude in Chrome is off in Settings → Agents." });
    expect(
      browserStatus(
        { ...claude, ...worker },
        { ...allOn, workspaces: {} },
        { outwardGate: "all" },
        {},
      ),
    ).toEqual({ state: "held", why: "Workers' browser is off in Settings → Workspaces." });
    expect(
      browserStatus({ ...claude, ...worker }, allOn, { ...granted, outwardGate: "all" }, {}),
    ).toEqual({ state: "on" });
  });
});

describe("browserNotReady", () => {
  it("says nothing while a browser server is connected or still starting", () => {
    expect(
      browserNotReady("claude", [{ name: "claude-in-chrome", status: "connected" }]),
    ).toBeUndefined();
    expect(
      browserNotReady("codex", [
        { name: "node_repl", status: "failed" },
        { name: "cua_repl", status: "pending" },
      ]),
    ).toBeUndefined();
  });

  it("names what a Claude session's extension lacks, and stays quiet when it lists none", () => {
    expect(
      browserNotReady("claude", [
        { name: "claude-in-chrome", status: "failed", error: "no browser connected" },
      ]),
    ).toBe(
      "Claude in Chrome isn't connected (no browser connected). Check that Chrome is open with the Claude extension installed and signed in.",
    );
    expect(browserNotReady("claude", [{ name: "claude-in-chrome", status: "needs-auth" }])).toMatch(
      /sign in to claude\.ai/,
    );
    // Claude Code may not list its built-in server, so its absence says nothing.
    expect(browserNotReady("claude", [{ name: "github", status: "connected" }])).toBeUndefined();
  });

  it("says a Codex session without the plugin's servers has no computer use", () => {
    expect(browserNotReady("codex", [{ name: "github", status: "connected" }])).toMatch(
      /Install computer use from the ChatGPT app/,
    );
    expect(browserNotReady("codex", [{ name: "cua_repl", status: "failed" }])).toBe(
      "Codex computer use isn't running (cua_repl: failed). Check that the ChatGPT app is open.",
    );
    expect(browserNotReady("codex", [{ name: "node_repl", status: "disabled" }])).toMatch(
      /turned off in this session \(node_repl\)/,
    );
  });
});
