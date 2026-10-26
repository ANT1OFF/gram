import type { LaunchChecks } from "@gram/contracts";

/** e2e specs put a partial `LaunchChecks` here (sessionStorage) to simulate a missing tool. */
export const MOCK_LAUNCH_CHECKS_KEY = "gram.mock.launchChecks";

const ALL_GOOD: Omit<LaunchChecks, "checkedAt"> = {
  tools: [
    { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.273" },
    { tool: "git", found: true, path: "/usr/bin/git", version: "2.47.1" },
    { tool: "gh", found: true, path: "/mock/bin/gh", version: "2.63.0" },
    {
      tool: "codex",
      found: true,
      path: "/mock/bin/codex",
      version: "0.159.2",
      testedVersion: "0.159.2",
      upgradeCommand: "npm i -g @openai/codex@0.159.2",
    },
  ],
  claudeSignIn: "signedIn",
  codexSignIn: "signedIn",
  ghSignedIn: true,
  agentsInUse: [],
  codexGatewayInherits: { skills: ["/mock/home/.codex/skills"] },
};

/** The version each CLI the mock updated now reports, kept like the machine would keep it. */
export const MOCK_UPDATED_CLIS_KEY = "gram.mock.updatedClis";

/** The CLIs the mock updated, by tool, and the version each now reports. */
export function updatedClis(): Readonly<Record<string, string>> {
  try {
    const saved =
      typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(MOCK_UPDATED_CLIS_KEY);
    return saved ? (JSON.parse(saved) as Record<string, string>) : {};
  } catch {
    // A malformed record updates nothing.
    return {};
  }
}

/** Records that the mock updated `tool` to `version`. */
export function recordUpdatedCli(tool: string, version: string): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(
    MOCK_UPDATED_CLIS_KEY,
    JSON.stringify({ ...updatedClis(), [tool]: version }),
  );
}

/** Every tool installed and signed in, unless a spec stored an override. */
export function mockLaunchChecks(): LaunchChecks {
  let override: Partial<LaunchChecks> = {};
  try {
    const saved =
      typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(MOCK_LAUNCH_CHECKS_KEY);
    if (saved) override = JSON.parse(saved) as Partial<LaunchChecks>;
  } catch {
    // A malformed override keeps the defaults.
  }
  const checks = { ...ALL_GOOD, ...override, checkedAt: Date.now() };
  const updated = updatedClis();
  return {
    ...checks,
    tools: checks.tools.map((tool) => {
      const version = updated[tool.tool];
      return version === undefined || !tool.found ? tool : { ...tool, version };
    }),
  };
}
