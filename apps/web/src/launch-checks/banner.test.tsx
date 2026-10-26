// @vitest-environment happy-dom
import {
  applySettingsPatch,
  type AgentRuntimes,
  type CliUpdateState,
  CliUpdateRefused,
  DEFAULT_SETTINGS,
  type Diagnostics,
  type LaunchChecks,
  type SettingsPatch,
} from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChannel, type Channel } from "@/api/channel";
import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { useServerSettings } from "@/settings-sync/store";

import { LaunchChecksBanner } from "./banner";
import { AgentChecks, ToolChecks } from "./tool-checks";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
}));

const SIGNED_OUT: LaunchChecks = {
  checkedAt: 1,
  tools: [
    { tool: "claude", found: true, path: "/opt/bin/claude", version: "2.1.273" },
    { tool: "git", found: true, path: "/usr/bin/git", version: "2.47.1" },
    { tool: "gh", found: false },
  ],
  claudeSignIn: "notSignedIn",
  ghSignedIn: false,
};

const watches: Array<{
  signal: AbortSignal;
  states: CliUpdateState["state"][];
  settled: Promise<void>;
}> = [];

const idleUpdateFeed = (_agent: string, signal: AbortSignal) => {
  const feed = createChannel<CliUpdateState>(signal);
  feed.push({ state: "idle" });
  return feed;
};

const renderWith = (api: Partial<Api>, children: ReactNode) => {
  const source = api.watchCliUpdate ?? idleUpdateFeed;
  const watchCliUpdate: Api["watchCliUpdate"] = (agent, signal) => {
    const settled = Promise.withResolvers<void>();
    const states: CliUpdateState["state"][] = [];
    watches.push({ signal, states, settled: settled.promise });
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const next of source(agent, signal)) {
            states.push(next.state);
            yield next;
          }
        } finally {
          settled.resolve();
        }
      },
    };
  };
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ApiProvider api={{ ...api, watchCliUpdate } as Api}>{children}</ApiProvider>
    </QueryClientProvider>,
  );
};

/** The app version and a settings store the banner saves into, as the server would. */
const appAt = (version: string) => ({
  diagnostics: vi.fn(async () => ({ version }) as unknown as Diagnostics),
  updateSettings: vi.fn(async (patch: SettingsPatch) =>
    applySettingsPatch(useServerSettings.getState().settings ?? DEFAULT_SETTINGS, patch),
  ),
});

const seedDismissed = (keys: string[]) =>
  useServerSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      onboarding: { welcomeSeen: true, dismissedLaunchIssues: keys },
    },
  });

/** The line under a launch-check Update, re-read since each state renders a new one. */
const outcome = () => screen.getByTestId("banner-cli-update");

beforeEach(() => {
  watches.length = 0;
  useServerSettings.setState({ settings: DEFAULT_SETTINGS });
  vi.spyOn(console, "warn");
  vi.spyOn(console, "error");
});
afterEach(async () => {
  cleanup();
  try {
    for (const watch of watches) expect(watch.signal.aborted).toBe(true);
    await Promise.all(watches.map((watch) => watch.settled));
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

describe("LaunchChecksBanner", () => {
  it("lists the problems with a details link, and a dismissal survives a restart", async () => {
    const launchChecks = vi.fn(async () => SIGNED_OUT);
    const app = appAt("0.4.0");
    renderWith({ launchChecks, ...app }, <LaunchChecksBanner />);

    const banner = await screen.findByTestId("launch-checks-banner");
    expect(banner.textContent).toContain("Claude Code isn't signed in. Run claude in a terminal");
    expect(banner.querySelector("code")?.textContent).toBe("claude");
    expect(banner.textContent).toContain("gh isn't installed. PR badges and reviews are off.");
    expect(screen.getByRole("link", { name: "Details" }).getAttribute("href")).toBe(
      "/settings/diagnostics",
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("launch-checks-banner")).toBeNull();
    await waitFor(() =>
      expect(app.updateSettings).toHaveBeenCalledWith({
        onboarding: { dismissedLaunchIssues: ["0.4.0:claude-signed-out", "0.4.0:gh-missing"] },
      }),
    );
    cleanup();

    // A restart: fresh component state, the dismissal read back from settings.
    renderWith({ launchChecks, ...appAt("0.4.0") }, <LaunchChecksBanner />);
    await waitFor(() => expect(launchChecks).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("launch-checks-banner")).toBeNull();
  });

  it("shows a dismissed problem again once the result changes or the app updates", async () => {
    seedDismissed(["0.4.0:claude-signed-out", "0.4.0:gh-missing"]);
    const apiKey = { ...SIGNED_OUT, claudeSignIn: "apiKey" as const };
    renderWith(
      { launchChecks: vi.fn(async () => apiKey), ...appAt("0.4.0") },
      <LaunchChecksBanner />,
    );
    const banner = await screen.findByTestId("launch-checks-banner");
    expect(banner.textContent).toContain("Claude Code is using an API key");
    expect(banner.textContent).not.toContain("gh isn't installed");
    cleanup();

    renderWith(
      { launchChecks: vi.fn(async () => SIGNED_OUT), ...appAt("0.5.0") },
      <LaunchChecksBanner />,
    );
    expect((await screen.findByTestId("launch-checks-banner")).textContent).toContain(
      "gh isn't installed",
    );
  });

  it("drops other versions' dismissals when saving a new one", async () => {
    seedDismissed(["0.3.0:gh-missing", "0.4.0:git-missing"]);
    const app = appAt("0.4.0");
    renderWith({ launchChecks: vi.fn(async () => SIGNED_OUT), ...app }, <LaunchChecksBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(app.updateSettings).toHaveBeenCalledWith({
        onboarding: {
          dismissedLaunchIssues: [
            "0.4.0:git-missing",
            "0.4.0:claude-signed-out",
            "0.4.0:gh-missing",
          ],
        },
      }),
    );
  });

  it("re-checks on demand and hides once the problems are fixed", async () => {
    const launchChecks = vi.fn(async (refresh?: boolean) =>
      refresh
        ? {
            ...SIGNED_OUT,
            claudeSignIn: "signedIn" as const,
            ghSignedIn: true,
            tools: SIGNED_OUT.tools.map((tool) => ({ ...tool, found: true })),
          }
        : SIGNED_OUT,
    );
    renderWith({ launchChecks, ...appAt("0.4.0") }, <LaunchChecksBanner />);

    fireEvent.click(await screen.findByRole("button", { name: "Re-check" }));
    await waitFor(() => expect(screen.queryByTestId("launch-checks-banner")).toBeNull());
    expect(launchChecks).toHaveBeenLastCalledWith(true);
  });

  it("renders nothing when the check isn't available", async () => {
    const launchChecks = vi.fn(async () => {
      throw new Error("NotImplemented");
    });
    renderWith({ launchChecks, ...appAt("0.4.0") }, <LaunchChecksBanner />);
    await waitFor(() => expect(launchChecks).toHaveBeenCalled());
    expect(screen.queryByTestId("launch-checks-banner")).toBeNull();
  });

  it("gives each local sign-in command as code", async () => {
    const launchChecks = vi.fn(async () => ({
      ...SIGNED_OUT,
      tools: SIGNED_OUT.tools.map((t) => (t.tool === "gh" ? { ...t, found: true } : t)),
    }));
    renderWith({ launchChecks, ...appAt("0.4.0") }, <LaunchChecksBanner />);

    const banner = await screen.findByTestId("launch-checks-banner");
    expect(banner.textContent).toContain("Claude Code isn't signed in. Run claude in a terminal");
    expect(banner.textContent).toContain(
      "gh isn't signed in. Run gh auth login to turn on PR badges and reviews.",
    );
    expect([...banner.querySelectorAll("code")].map((code) => code.textContent)).toEqual([
      "claude",
      "gh auth login",
    ]);
  });
});

describe("LaunchChecksBanner Update", () => {
  const OUTDATED: LaunchChecks = {
    ...SIGNED_OUT,
    tools: [
      { tool: "claude", found: true, path: "/opt/bin/claude", version: "2.1.273" },
      { tool: "git", found: true, path: "/usr/bin/git", version: "2.47.1" },
      { tool: "gh", found: true, path: "/opt/bin/gh", version: "2.63.0" },
      {
        tool: "codex",
        found: true,
        path: "/opt/bin/codex",
        version: "0.159.2",
        testedVersion: "0.160.1",
        upgradeCommand: "npm i -g @openai/codex@0.160.1",
      },
    ],
    claudeSignIn: "signedIn",
    ghSignedIn: true,
    agentsInUse: ["codex"],
  };
  const COMMAND = "npm i -g @openai/codex@0.160.1";
  const listing: AgentRuntimes = {
    checkedAt: 1,
    agents: [
      {
        agent: "codex",
        resolved: { source: "path", path: "/opt/bin/codex", version: "0.159.2" },
        baseline: { cliVersion: "0.160.1", binding: "codex-protocol", bindingVersion: "0.160.1" },
        verdict: "graceful",
        installSteps: [
          {
            installer: "npm",
            command: COMMAND,
            exact: true,
            version: "0.160.1",
            run: ["npm", "i", "-g", "@openai/codex@0.160.1"],
          },
        ],
      },
    ],
  };
  const run = { command: COMMAND, output: "" };

  /** An API whose update feed the test drives, and whose launch checks follow `checks`. */
  const updatable = (overrides: Partial<Api> = {}) => {
    let feed: Channel<CliUpdateState> | undefined;
    const state = { checks: OUTDATED };
    const api = {
      ...appAt("0.11.0"),
      launchChecks: vi.fn(async () => state.checks),
      agentRuntimes: vi.fn(async () => listing),
      watchCliUpdate: vi.fn((_agent: string, signal: AbortSignal) => {
        feed = createChannel<CliUpdateState>(signal);
        feed.push({ state: "idle" });
        return feed;
      }),
      updateCli: vi.fn(async (): Promise<CliUpdateState> => {
        const running = { state: "running" as const, ...run, startedAt: 1, runningThreads: 0 };
        feed?.push(running);
        return running;
      }),
      ...overrides,
    } satisfies Partial<Api>;
    return { api, state, push: (next: CliUpdateState) => feed!.push(next) };
  };

  it("runs the Agents row's step in one click, and the line goes once the checks read the new version", async () => {
    const { api, state, push } = updatable();
    renderWith(api, <LaunchChecksBanner />);
    const update = await screen.findByRole("button", { name: "Update Codex" });
    fireEvent.click(update);
    expect(api.updateCli).toHaveBeenCalledWith("codex", COMMAND);
    await waitFor(() =>
      expect(screen.getByTestId("banner-cli-update").getAttribute("data-state")).toBe("running"),
    );
    expect(screen.queryByRole("button", { name: "Update Codex" })).toBeNull();

    state.checks = {
      ...OUTDATED,
      tools: OUTDATED.tools.map((t) => (t.tool === "codex" ? { ...t, version: "0.160.1" } : t)),
    };
    push({ state: "succeeded", ...run, from: "0.159.2", version: "0.160.1", runningThreads: 0 });
    await waitFor(() => expect(screen.queryByTestId("launch-checks-banner")).toBeNull());
  });

  it("shows a failure inline with the command to copy, and offers Update again", async () => {
    const { api, push } = updatable();
    renderWith(api, <LaunchChecksBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Update Codex" }));
    push({
      state: "failed",
      ...run,
      problem: "sign-in",
      message: "npm registry sign-in expired: run `npm login`, then try again.",
    });
    await waitFor(() => expect(outcome().getAttribute("data-state")).toBe("failed"));
    expect(outcome().textContent).toContain("npm registry sign-in expired: run npm login");
    expect(screen.getByRole("button", { name: `Copy ${COMMAND}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update Codex" })).toBeTruthy();

    // The package manager's own failure points at the Agents row, which has its output.
    push({ state: "failed", ...run, problem: "failed", message: "stopped. Its output is below." });
    await waitFor(() =>
      expect(screen.getByTestId("banner-cli-update").textContent).toBe(
        `${COMMAND} failed. Settings → Agents shows its output.`,
      ),
    );
  });

  it("says why the server wouldn't start it", async () => {
    const { api } = updatable({
      updateCli: vi.fn(async () => {
        throw new CliUpdateRefused({
          agent: "codex",
          reason: "not-offered",
          message: "Gram doesn't offer to run that for Codex now.",
        });
      }),
    });
    renderWith(api, <LaunchChecksBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Update Codex" }));
    await waitFor(() => expect(outcome().getAttribute("data-state")).toBe("refused"));
    expect(outcome().textContent).toContain("doesn't offer to run that for Codex now");
  });

  it("requires a runnable Update step", async () => {
    const copyOnly: AgentRuntimes = {
      ...listing,
      agents: listing.agents.map((a) => ({
        ...a,
        installSteps: a.installSteps.map(({ run: _run, ...step }) => step),
      })),
    };
    const { api } = updatable({ agentRuntimes: vi.fn(async () => copyOnly) });
    renderWith(api, <LaunchChecksBanner />);
    await screen.findByTestId("launch-checks-banner");
    await waitFor(() => expect(api.agentRuntimes).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Update Codex" })).toBeNull();
  });
});

describe("ToolChecks", () => {
  it("shows each tool's version, path and sign-in state", async () => {
    renderWith({ launchChecks: vi.fn(async () => SIGNED_OUT) }, <ToolChecks />);
    const tools = await screen.findByTestId("tool-checks");
    await waitFor(() =>
      expect(tools.textContent).toContain("2.1.273 at /opt/bin/claude, not signed in"),
    );
    expect(tools.textContent).toContain("not found on the login-shell PATH");
  });

  it("says why no thread can start from a Claude that was found", async () => {
    const unusable =
      "C:\\npm\\claude.cmd doesn't run a native claude.exe, which Claude threads need.";
    const [claude, ...rest] = SIGNED_OUT.tools;
    renderWith(
      {
        launchChecks: vi.fn(async () => ({
          ...SIGNED_OUT,
          tools: [{ ...claude!, unusable }, ...rest],
        })),
      },
      <ToolChecks />,
    );
    const tools = await screen.findByTestId("tool-checks");
    await waitFor(() => expect(tools.textContent).toContain(`can't start threads: ${unusable}`));
  });
});

describe("AgentChecks", () => {
  const runtimes: AgentRuntimes = {
    checkedAt: 1,
    agents: [
      {
        agent: "codex",
        baseline: { cliVersion: "0.159.2", binding: "codex-protocol", bindingVersion: "0.159.2" },
        verdict: "unknown",
        reason: "Not installed.",
        newer: {
          version: "0.159.4",
          channel: "stable",
          publishedAt: 1,
          eligibleAt: 2,
          eligible: true,
          verdict: "supported",
        },
        installSteps: [
          { installer: "npm", command: "npm i -g @openai/codex@0.159.4", exact: true },
        ],
      },
    ],
  };

  it("explains Nix ownership and the real executable without offering a replacement install", async () => {
    const note =
      "Nix owns this installation. Update your Home Manager configuration, then Re-check.";
    const row = runtimes.agents[0]!;
    const owned: AgentRuntimes = {
      ...runtimes,
      agents: [
        {
          ...row,
          agent: "claude",
          resolved: { source: "path", path: "/etc/profiles/per-user/me/bin/claude" },
          installation: {
            installer: "nix",
            realPath: "/nix/store/synthetic-claude/bin/claude",
            updateNote: note,
          },
          installSteps: [],
        },
      ],
    };
    renderWith(
      {
        launchChecks: vi.fn(async (): Promise<LaunchChecks> => ({
          ...SIGNED_OUT,
          claudeSignIn: "signedIn",
          tools: [
            ...SIGNED_OUT.tools.filter((t) => t.tool !== "claude"),
            { tool: "claude", found: true, path: "/etc/profiles/per-user/me/bin/claude" },
          ],
        })),
        agentRuntimes: vi.fn(async () => owned),
      },
      <AgentChecks />,
    );
    await waitFor(() => {
      expect(watches).toHaveLength(2);
      for (const watch of watches) expect(watch.states).toEqual(["idle"]);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Claude Code details" }));
    const details = screen.getByTestId("runtime-details");
    expect(details.textContent).toContain("Nix / Home Manager");
    expect(details.textContent).toContain("/nix/store/synthetic-claude/bin/claude");
    expect(screen.getByTestId("runtime-update-note").textContent).toBe(note);
    expect(details.querySelector("[data-testid=runtime-steps]")).toBeNull();
    const claude = screen.getByRole("group", { name: "Claude Code" });
    expect(claude.querySelector("[data-testid=cli-update]")).toBeNull();
    expect(claude.querySelector('[aria-label^="Copy"]')).toBeNull();
  });

  it("shows each agent's version, marks only trouble, and re-checks", async () => {
    const launchChecks = vi.fn(async (_force?: boolean) => SIGNED_OUT);
    const agentRuntimes = vi.fn(async (_refresh?: boolean) => runtimes);
    renderWith({ launchChecks, agentRuntimes }, <AgentChecks />);
    const claude = await screen.findByRole("group", { name: "Claude Code" });
    expect(claude.textContent).toContain("2.1.273");
    expect(claude.textContent).toContain("not signed in");
    expect(claude.getAttribute("data-trouble")).toBe("error");
    expect(screen.getByRole("button", { name: "Copy the fix: claude" })).toBeTruthy();
    // Nobody relies on Codex here, so its absence is said, not flagged.
    const codex = screen.getByRole("group", { name: "Codex" });
    expect(codex.textContent).toContain("not installed");
    expect(codex.getAttribute("data-trouble")).toBeNull();

    // The runtime listing adds the newer release, a step to copy and the details behind them.
    await waitFor(() => expect(codex.textContent).toContain("0.159.4 available"));
    expect(
      screen.getByRole("button", { name: "Copy npm i -g @openai/codex@0.159.4" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Codex details" }));
    expect(codex.querySelector("[data-testid=runtime-details]")?.textContent).toContain(
      "app-server protocol generated from Codex 0.159.2",
    );

    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));
    // The server's runtime re-check runs the launch checks again; the page then reads that run.
    await waitFor(() => expect(agentRuntimes).toHaveBeenCalledWith(true));
    await waitFor(() => expect(launchChecks).toHaveBeenCalledTimes(2));
  });

  it("offers Claude's local sign-in fix", async () => {
    const launchChecks = vi.fn(async () => SIGNED_OUT);
    const agentRuntimes = vi.fn(async () => runtimes);
    renderWith({ launchChecks, agentRuntimes }, <AgentChecks />);
    const claude = await screen.findByRole("group", { name: "Claude Code" });
    await waitFor(() => expect(claude.textContent).toContain("not signed in"));
    expect(claude.getAttribute("data-trouble")).toBe("error");
    expect(screen.getByRole("button", { name: "Copy the fix: claude" })).toBeTruthy();
  });

  it("says how to renew a refused registry sign-in, and only for that", async () => {
    const launchChecks = vi.fn(async () => SIGNED_OUT);
    const refused: AgentRuntimes = {
      ...runtimes,
      releasesUnavailable: {
        problem: "sign-in",
        message: "npm registry sign-in expired: run npm login",
      },
    };
    renderWith({ launchChecks, agentRuntimes: vi.fn(async () => refused) }, <AgentChecks />);
    const hint = await screen.findByTestId("registry-sign-in");
    expect(hint.textContent).toContain("npm registry sign-in expired: run npm login");
    expect(screen.getByRole("button", { name: "Copy npm login" })).toBeTruthy();
    cleanup();

    const missing: AgentRuntimes = {
      ...runtimes,
      releasesUnavailable: { problem: "npm-missing", message: "npm isn't installed" },
    };
    renderWith({ launchChecks, agentRuntimes: vi.fn(async () => missing) }, <AgentChecks />);
    fireEvent.click(await screen.findByRole("button", { name: "Codex details" }));
    expect(screen.getByTestId("runtime-details").textContent).toContain(
      "can't check: npm isn't installed",
    );
    expect(screen.queryByTestId("registry-sign-in")).toBeNull();
  });
});
