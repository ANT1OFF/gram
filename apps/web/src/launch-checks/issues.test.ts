import { type AgentRuntime, type LaunchChecks } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  bindingLabel,
  installing,
  installProgress,
  newerNote,
  stepLabel,
  verdictTone,
} from "./agent-runtime-model";
import { isOlderVersion, launchIssues } from "./issues";
import {
  agentStatuses,
  codexInheritsSummary,
  HARNESSES,
  toolSummary,
  type Harness,
} from "./tool-checks-model";

const checks = (overrides: Partial<LaunchChecks> = {}): LaunchChecks => ({
  checkedAt: 0,
  tools: [
    { tool: "claude", found: true },
    { tool: "git", found: true },
    { tool: "gh", found: true },
  ],
  claudeSignIn: "signedIn",
  ghSignedIn: true,
  ...overrides,
});

const ids = (value: LaunchChecks) => launchIssues(value).map((issue) => issue.id);

/** An installed Codex one release behind the tested version. */
const codex = (overrides: Partial<LaunchChecks["tools"][number]> = {}) => ({
  tool: "codex" as const,
  found: true,
  path: "/opt/bin/codex",
  version: "0.153.4",
  testedVersion: "0.154.0",
  upgradeCommand: "npm i -g @openai/codex@0.154.0",
  ...overrides,
});

/** The all-good checks plus `tool`, with `agentsInUse` when given. */
const withCodex = (tool: LaunchChecks["tools"][number], agentsInUse: LaunchChecks["agentsInUse"]) =>
  checks({
    tools: [...checks().tools, tool],
    ...(agentsInUse === undefined ? {} : { agentsInUse }),
  });

describe("launchIssues", () => {
  it("reports nothing when everything is installed and signed in", () => {
    expect(launchIssues(checks())).toEqual([]);
  });

  it("reports a signed-out Claude with the command, and a missing gh", () => {
    const issues = launchIssues(
      checks({
        claudeSignIn: "notSignedIn",
        tools: [
          { tool: "claude", found: true },
          { tool: "git", found: true },
          { tool: "gh", found: false },
        ],
      }),
    );
    expect(issues.map((issue) => issue.text)).toEqual([
      "Claude Code isn't signed in. Run `claude` in a terminal to sign in.",
      "gh isn't installed. PR badges and reviews are off.",
    ]);
  });

  it("prefers a missing Claude over its sign-in state, and a signed-out gh over nothing", () => {
    expect(
      ids(
        checks({
          claudeSignIn: "unknown",
          ghSignedIn: false,
          tools: [
            { tool: "claude", found: false },
            { tool: "codex", found: true },
            { tool: "git", found: false },
            { tool: "gh", found: true },
          ],
        }),
      ),
    ).toEqual(["claude-missing", "git-missing", "gh-signed-out"]);
  });

  it("says once that no agent is installed, instead of naming one the user may not want", () => {
    const neither = checks({
      claudeSignIn: "unknown",
      tools: [
        { tool: "claude", found: false },
        codex({ found: false }),
        { tool: "git", found: true },
        { tool: "gh", found: true },
      ],
      agentsInUse: ["codex"],
      localAgentsInUse: ["claude"],
    });
    expect(launchIssues(neither)).toEqual([
      {
        id: "agents-missing",
        text: "Neither Claude Code nor Codex is installed, so no thread can start. Install one, sign in, then re-check.",
      },
    ]);
  });

  it("reports a Claude no thread can start from, with the reason, over its sign-in state", () => {
    const unusable =
      "C:\\npm\\claude.cmd doesn't run a native claude.exe, which Claude threads need.";
    expect(
      launchIssues(
        checks({
          claudeSignIn: "notSignedIn",
          tools: [{ tool: "claude", found: true, unusable }, ...checks().tools.slice(1)],
        }),
      ),
    ).toEqual([{ id: "claude-unusable", text: unusable }]);
  });

  it("flags API-key and third-party auth but not an unreadable status", () => {
    expect(ids(checks({ claudeSignIn: "apiKey" }))).toEqual(["claude-api-key"]);
    expect(ids(checks({ claudeSignIn: "thirdParty" }))).toEqual(["claude-third-party"]);
    expect(ids(checks({ claudeSignIn: "unknown" }))).toEqual([]);
  });

  it("tells a Codex user their CLI is older than the tested version, with the upgrade command", () => {
    expect(launchIssues(withCodex(codex(), ["codex"]))).toEqual([
      {
        id: "codex-outdated-0.153.4",
        text: "Codex 0.153.4 is older than the 0.154.0 Gram is tested with. Some features may not work. Upgrade with `npm i -g @openai/codex@0.154.0`.",
        update: "codex",
      },
    ]);
  });

  it("says nothing about Codex to someone who doesn't use it, or when it's current or newer", () => {
    expect(ids(withCodex(codex(), []))).toEqual([]);
    expect(ids(withCodex(codex(), undefined))).toEqual([]);
    expect(ids(withCodex(codex({ version: "0.154.0" }), ["codex"]))).toEqual([]);
    expect(ids(withCodex(codex({ version: "0.155.1" }), ["codex"]))).toEqual([]);
    const { version: _unreadable, ...unversioned } = codex();
    expect(ids(withCodex(unversioned, ["codex"]))).toEqual([]);
  });
});

describe("isOlderVersion", () => {
  it("compares MAJOR.MINOR.PATCH numerically", () => {
    expect(isOlderVersion("0.153.4", "0.154.0")).toBe(true);
    expect(isOlderVersion("1.9.0", "1.18.29")).toBe(true);
    expect(isOlderVersion("1.18.29", "1.18.29")).toBe(false);
    expect(isOlderVersion("2.0.0", "1.18.29")).toBe(false);
    expect(isOlderVersion("unknown", "1.18.29")).toBe(false);
  });
});

const statusOf = (value: LaunchChecks, agent: Harness) =>
  agentStatuses(value).find((status) => status.agent === agent)!;

describe("agentStatuses", () => {
  it("gives every harness a row, and a healthy one no trouble", () => {
    const value = {
      ...withCodex(codex({ version: "0.154.0" }), ["codex"]),
      codexSignIn: "signedIn" as const,
    };
    expect(agentStatuses(value).map((status) => status.agent)).toEqual(HARNESSES);
    expect(statusOf(value, "codex")).toEqual({
      agent: "codex",
      version: "0.154.0",
      note: "ChatGPT login",
    });
    expect(statusOf(value, "claude").trouble).toBeUndefined();
  });

  it("marks a Claude that isn't signed in, with the command that signs it in", () => {
    const trouble = statusOf(checks({ claudeSignIn: "notSignedIn" }), "claude").trouble;
    expect(trouble).toMatchObject({ level: "error", summary: "not signed in", fix: "claude" });
    expect(statusOf(checks({ claudeSignIn: "apiKey" }), "claude").trouble?.level).toBe("warning");
    // An unreadable sign-in isn't raised: a wrong alarm would be worse.
    expect(statusOf(checks({ claudeSignIn: "unknown" }), "claude").trouble).toBeUndefined();
  });

  it("offers the local Claude sign-in fix", () => {
    const value = checks({ claudeSignIn: "notSignedIn" });
    expect(agentStatuses(value)[0]?.trouble?.fix).toBe("claude");
  });

  it("puts a Claude that can't start threads ahead of its sign-in", () => {
    const unusable = "claude.cmd doesn't run a native claude.exe.";
    const value = checks({
      claudeSignIn: "notSignedIn",
      tools: [{ tool: "claude", found: true, unusable }, ...checks().tools.slice(1)],
    });
    expect(statusOf(value, "claude").trouble).toEqual({
      level: "error",
      summary: "can't start threads",
      detail: unusable,
    });
  });

  it("marks an outdated gateway agent in use, with the upgrade to copy", () => {
    // Nobody relies on it: said, not flagged, as the launch banner doesn't raise it either.
    expect(statusOf(withCodex(codex(), []), "codex")).toEqual({
      agent: "codex",
      version: "0.153.4",
      note: "older than 0.154.0",
    });
    expect(statusOf(withCodex(codex(), ["codex"]), "codex")).toEqual({
      agent: "codex",
      version: "0.153.4",
      trouble: {
        level: "warning",
        summary: "older than 0.154.0",
        detail:
          "Codex 0.153.4 is older than the 0.154.0 Gram is tested with. Some features may not work.",
        fix: "npm i -g @openai/codex@0.154.0",
      },
    });
  });

  it("calls a missing gateway agent trouble only for someone who uses it", () => {
    const missing = codex({ found: false });
    expect(statusOf(withCodex(missing, []), "codex")).toEqual({
      agent: "codex",
      note: "not installed",
    });
    expect(statusOf(withCodex(missing, ["codex"]), "codex").trouble).toMatchObject({
      level: "error",
      summary: "not installed",
      fix: "npm i -g @openai/codex@0.154.0",
    });
    expect(statusOf(checks(), "codex")).toEqual({ agent: "codex", note: "not installed" });
  });
});

describe("toolSummary", () => {
  it("says where a tool is, its sign-in and the version it is tested with", () => {
    const value = checks({ claudeSignIn: "apiKey", ghSignedIn: false });
    expect(
      toolSummary({ tool: "claude", found: true, path: "/bin/claude", version: "2.1.3" }, value),
    ).toBe("2.1.3 at /bin/claude, using an API key");
    expect(toolSummary({ tool: "gh", found: true }, value)).toBe("version unknown, not signed in");
    expect(toolSummary(codex(), value)).toBe(
      "0.153.4 at /opt/bin/codex, sign-in unknown, tested with 0.154.0",
    );
    expect(toolSummary(codex({ found: false }), value)).toBe(
      "not found on the login-shell PATH, tested with 0.154.0",
    );
  });
});

describe("codexInheritsSummary", () => {
  it("names the skill folders and instructions gateway Codex threads use, or nothing", () => {
    expect(codexInheritsSummary(checks())).toBeUndefined();
    expect(codexInheritsSummary(checks({ codexGatewayInherits: { skills: [] } }))).toBeUndefined();
    expect(
      codexInheritsSummary(checks({ codexGatewayInherits: { skills: ["/h/.codex/skills"] } })),
    ).toBe("gateway threads use your skills in /h/.codex/skills");
    expect(
      codexInheritsSummary(
        checks({
          codexGatewayInherits: {
            skills: ["/h/.agents/skills", "/h/.codex/skills"],
            instructions: "/h/.codex/AGENTS.md",
          },
        }),
      ),
    ).toBe(
      "gateway threads use your skills in /h/.agents/skills and /h/.codex/skills, and instructions from /h/.codex/AGENTS.md",
    );
  });
});

describe("agent runtime rows", () => {
  const base: AgentRuntime = {
    agent: "codex",
    resolved: { source: "path", path: "/bin/codex", version: "0.159.2" },
    baseline: { cliVersion: "0.159.2", binding: "codex-protocol", bindingVersion: "0.159.2" },
    verdict: "supported",
    installSteps: [],
  };
  const newer = (over: Partial<NonNullable<AgentRuntime["newer"]>>): AgentRuntime => ({
    ...base,
    newer: {
      version: "0.159.4",
      channel: "stable",
      publishedAt: Date.UTC(2026, 9, 1, 15, 12),
      eligibleAt: Date.UTC(2026, 9, 2, 15, 12),
      eligible: true,
      verdict: "supported",
      ...over,
    },
  });

  it("says what a newer release means, the 24-hour wait first", () => {
    expect(newerNote(base)).toBeUndefined();
    expect(newerNote(newer({}))).toMatchObject({ kind: "update", summary: "0.159.4 available" });
    expect(newerNote(newer({ eligible: false }))).toMatchObject({
      kind: "waiting",
      summary: expect.stringMatching(/^0\.159\.4 after 2 Oct, \d\d:12$/),
      detail: expect.stringContaining("at least 24 hours"),
    });
    // Too fresh wins over anything said about its compatibility.
    expect(newerNote(newer({ eligible: false, verdict: "unknown" }))?.kind).toBe("waiting");
    expect(newerNote(newer({ verdict: "unknown" }))).toMatchObject({
      kind: "pending",
      summary: "0.159.4 · check pending",
    });
    expect(newerNote(newer({ verdict: "unsupported" }))).toMatchObject({
      kind: "blocked",
      summary: "0.159.4 needs a newer Gram",
    });
  });

  it("marks only versions that aren't plainly supported, and nothing for a missing CLI", () => {
    expect(verdictTone(base)).toBe("ok");
    expect(verdictTone({ ...base, verdict: "graceful" })).toBe("warning");
    expect(verdictTone({ ...base, verdict: "unsupported" })).toBe("error");
    expect(verdictTone({ ...base, verdict: "unknown" })).toBe("unknown");
    const { resolved: _, ...missing } = base;
    expect(verdictTone({ ...missing, verdict: "unknown" })).toBe("ok");
  });

  it("names steps, bindings and install progress in a few words", () => {
    expect(stepLabel({ installer: "npm", command: "npm i -g x@1.0.0", exact: true })).toBe("npm");
    expect(stepLabel({ installer: "brew", command: "brew upgrade codex", exact: false })).toBe(
      "Homebrew, latest",
    );
    expect(bindingLabel(base)).toBe("app-server protocol generated from Codex 0.159.2");
    expect(installProgress({ state: "idle" })).toBeUndefined();
    expect(
      installProgress({
        state: "downloading",
        version: "0.159.4",
        receivedBytes: 34_000_000,
        totalBytes: 129_000_000,
      }),
    ).toBe("Downloading 34 / 129 MB");
    expect(installProgress({ state: "ready", version: "0.159.4", activeSessions: 2 })).toBe(
      "Update ready · 2 active sessions",
    );
    const active = { version: "0.159.2", sha256: "0".repeat(64), path: "/s", installedAt: 1 };
    expect(installProgress({ state: "failed", version: "0.159.4", message: "x", active })).toBe(
      "Update failed; still using 0.159.2",
    );
    expect(installing({ state: "testing", version: "0.159.4" })).toBe(true);
    expect(installing({ state: "ready", version: "0.159.4", activeSessions: 0 })).toBe(false);
  });
});

const localCodex = (codexSignIn: NonNullable<LaunchChecks["codexSignIn"]>) =>
  checks({
    tools: [
      { tool: "claude", found: false },
      { tool: "codex", found: true, version: "0.160.1" },
      { tool: "git", found: true },
      { tool: "gh", found: true },
    ],
    claudeSignIn: "unknown",
    codexSignIn,
    agentsInUse: ["codex"],
    localAgentsInUse: ["codex"],
  });

describe("individual subscription diagnostics", () => {
  it("supports a Codex-only user without requiring Claude", () => {
    expect(launchIssues(localCodex("signedIn"))).toEqual([]);
    expect(statusOf(localCodex("signedIn"), "claude")).toEqual({
      agent: "claude",
      note: "not installed",
    });
    expect(statusOf(localCodex("signedIn"), "codex")).toEqual({
      agent: "codex",
      version: "0.160.1",
      note: "ChatGPT login",
    });
  });
  it("offers the CLI login command for a selected signed-out Codex account", () => {
    expect(launchIssues(localCodex("notSignedIn"))).toEqual([
      {
        id: "codex-signed-out",
        text: "Codex isn't signed in. Run `codex login` with your ChatGPT account, then re-check.",
      },
    ]);
    expect(statusOf(localCodex("notSignedIn"), "codex").trouble).toMatchObject({
      summary: "not signed in",
      fix: "codex login",
      level: "error",
    });
  });
  it("distinguishes separately billed API keys without calling them subscription access", () => {
    expect(launchIssues(localCodex("apiKey"))[0]?.id).toBe("codex-api-key");
    expect(statusOf(localCodex("apiKey"), "codex").trouble).toMatchObject({
      level: "warning",
      summary: "using an API key",
    });
    expect(toolSummary(localCodex("apiKey").tools[1]!, localCodex("apiKey"))).toContain(
      "using an API key",
    );
  });
  it("does not infer a ready login from an unknown status or warn a gateway-only workflow about local login", () => {
    expect(statusOf(localCodex("unknown"), "codex")).toEqual({
      agent: "codex",
      version: "0.160.1",
      note: "sign-in unknown",
    });
    const gatewayOnly = { ...localCodex("notSignedIn"), localAgentsInUse: [] };
    expect(launchIssues(gatewayOnly)).toEqual([]);
    expect(statusOf(gatewayOnly, "codex").trouble).toBeUndefined();
  });
});
