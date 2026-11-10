// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, RECOMMENDED, type LaunchChecks, type Settings } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { prefillDraftProject } from "@/composer/draft-prefill";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { canStart, runsWith, toolRows } from "./tools";
import { Welcome } from "./welcome";
import { useWelcome } from "./welcome-state";

const navigate = vi.fn(async (_to: unknown) => {});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={`#${to}`}>{children}</a>
  ),
  useNavigate: () => navigate,
}));

const withOnboarding = (onboarding: Partial<Settings["onboarding"]>): Settings => ({
  ...DEFAULT_SETTINGS,
  onboarding: { ...DEFAULT_SETTINGS.onboarding, ...onboarding },
});

/** Every CLI installed and signed in: set here, never read from the machine running the test. */
const ALL_READY: LaunchChecks = {
  checkedAt: 0,
  tools: [
    { tool: "claude", found: true, version: "2.1.273" },
    { tool: "codex", found: true, version: "0.160.0" },
    { tool: "git", found: true, version: "2.47.1" },
    { tool: "gh", found: true, version: "2.63.0" },
  ],
  claudeSignIn: "signedIn",
  codexSignIn: "signedIn",
  ghSignedIn: true,
};

/** A fresh session and API without re-evaluating the component, contracts and mock module graphs. */
function load(settings: Settings, checks: LaunchChecks = ALL_READY) {
  useWelcome.setState({ open: undefined });
  useServerSettings.setState({ settings });
  const api = createMockApi({ speed: 0, autoplay: false });
  vi.spyOn(api, "launchChecks").mockResolvedValue(checks);
  const updateSettings = vi.spyOn(api, "updateSettings");
  const render = () => renderWithApi(<Welcome />, api);
  return { api, render, updateSettings };
}

beforeEach(() => navigate.mockClear());

afterEach(() => {
  cleanup();
  prefillDraftProject(undefined);
  useWelcome.setState({ open: undefined });
  useServerSettings.setState({ settings: undefined });
});

describe("first run", () => {
  it("leads with a repository and the agent it runs on, Skip beside Open, the rest folded", async () => {
    const { api, render, updateSettings } = load(withOnboarding({}));
    for (const profile of await api.listProfiles()) await api.removeProfile(profile.id);
    render();

    const welcome = within(await screen.findByTestId("welcome"));
    // It leads with the repository: the screen's heading is the action.
    const heading = welcome.getByRole("heading", { name: "Open a repository" });
    expect(screen.getByTestId("welcome").querySelector("h2")).toBe(heading);
    await waitFor(() => expect(api.launchChecks).toHaveBeenCalled());
    await vi.mocked(api.launchChecks).mock.results[0]!.value;
    expect(await welcome.findByRole("radio", { name: /^api/ })).toBeTruthy();
    // One sentence says what a workspace and its orchestrator are; no steps grid before the pick.
    expect(welcome.getByTestId("welcome-line").textContent).toBe(
      "Gram makes it a workspace, whose orchestrator hands your tasks to agents and follows each one to a pull request.",
    );
    expect(welcome.queryByRole("list", { name: "Steps to start" })).toBeNull();
    // Open is the one primary action, Skip its secondary beside it, and readiness right under them.
    const actions = welcome.getByTestId("welcome-actions");
    const open = welcome.getByTestId("welcome-open");
    const skip = welcome.getByTestId("welcome-skip");
    expect(open.nextElementSibling).toBe(skip);
    expect(open.className).toContain("bg-primary");
    expect(skip.className).not.toContain("bg-primary");
    expect(skip.className).toContain("border");
    expect(actions.nextElementSibling).toBe(welcome.getByTestId("welcome-agents"));
    // Every agent ready: the line names them, and there is nothing to set up or re-check.
    expect(welcome.getByTestId("welcome-runs-with").textContent).toBe(
      "Runs with Claude Code or Codex",
    );
    expect(welcome.queryByRole("list", { name: "Tools to set up" })).toBeNull();
    expect(welcome.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(welcome.queryByRole("link", { name: /^Install/ })).toBeNull();
    // The most recent repository is picked, so the one primary action opens it; picking another
    // moves the check and the button with it.
    expect(welcome.getByRole("radio", { name: /^api/ }).getAttribute("aria-checked")).toBe("true");
    expect(open.textContent).toContain("Open api");
    // What Open leads to, the survey a new workspace starts with included.
    const next = welcome.getByTestId("welcome-next").textContent;
    expect(next).toContain("how much it may do on its own");
    expect(next).toContain("surveys api and suggests first tasks");
    fireEvent.click(welcome.getByRole("radio", { name: /^web/ }));
    expect(welcome.getByRole("radio", { name: /^web/ }).getAttribute("aria-checked")).toBe("true");
    expect(welcome.getByRole("radio", { name: /^api/ }).getAttribute("aria-checked")).toBe("false");
    expect(welcome.getByTestId("welcome-open").textContent).toContain("Open web");
    // How it works and the import are one footer of folds, each opening on its own.
    expect(welcome.queryByRole("list", { name: "How Gram works" })).toBeNull();
    fireEvent.click(welcome.getByRole("button", { name: "How it works" }));
    expect(
      within(welcome.getByRole("list", { name: "How Gram works" }))
        .getAllByRole("listitem")
        .map((step) => step.textContent),
    ).toEqual([
      expect.stringContaining("You give tasks"),
      expect.stringContaining("An orchestrator briefs workers"),
      expect.stringContaining("Each worker opens a PR"),
    ]);
    expect(welcome.queryByTestId("welcome-import-sessions")).toBeNull();
    fireEvent.click(welcome.getByRole("button", { name: "Import past CLI sessions" }));
    expect(welcome.getByTestId("welcome-import-sessions")).toBeTruthy();
    // The other ways in are behind one quiet action under the list, not a row of their own.
    expect(welcome.queryByRole("button", { name: "Open a folder…" })).toBeNull();
    expect(welcome.queryByRole("button", { name: "Clone from GitHub" })).toBeNull();
    fireEvent.click(welcome.getByRole("button", { name: "Add repository" }));
    expect(await screen.findByRole("menuitem", { name: "Open a folder…" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Clone from GitHub" })).toBeTruthy();
    // Six repositories fit; no search is offered for them.
    expect(welcome.queryByRole("searchbox", { name: "Find a repository" })).toBeNull();
    // Looking at it records nothing, and a first run never asks for a gateway key.
    expect(updateSettings).not.toHaveBeenCalled();
    expect(welcome.queryByRole("form", { name: "Connect the AI gateway" })).toBeNull();
    expect(await api.listProfiles()).toEqual([]);
  });

  it("opens the new-workspace sheet on the picked repository, and stays until a workspace is made", async () => {
    const { render, updateSettings } = load(withOnboarding({}));
    render();
    const welcome = within(await screen.findByTestId("welcome"));
    // A pick alone opens nothing; Open does.
    fireEvent.click(await welcome.findByRole("radio", { name: /^api/ }));
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(welcome.getByTestId("welcome-open"));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/new-workspace", search: { repo: "p-api" } }),
    );
    // Leaving the sheet with Esc comes back here; the sheet records it done. Going on keeps the
    // Recommended setup, on, so the new workspace starts on it; nothing else is recorded.
    expect(screen.getByTestId("welcome")).toBeTruthy();
    expect(updateSettings.mock.calls).toEqual([
      [{ agents: { recommendedSetup: { enabled: true, seen: RECOMMENDED.version } } }],
    ]);
  });

  it("keeps the Recommended setup off when switched off here, and saves it only on going on", async () => {
    const { render, updateSettings } = load(withOnboarding({}));
    render();
    const welcome = within(await screen.findByTestId("welcome"));
    const toggle = welcome.getByTestId("welcome-recommended-switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(updateSettings).not.toHaveBeenCalled();
    fireEvent.click(welcome.getByRole("button", { name: "Skip" }));
    await waitFor(() =>
      expect(updateSettings.mock.calls).toEqual([
        [{ agents: { recommendedSetup: { enabled: false, seen: RECOMMENDED.version } } }],
        [{ onboarding: { welcomeSeen: true } }],
      ]),
    );
  });

  it("adds a repository found in the default folder before opening the sheet on it", async () => {
    const { api, render } = load(withOnboarding({}));
    const add = vi.spyOn(api, "addProject");
    render();
    const welcome = within(await screen.findByTestId("welcome"));
    // A double-click opens the row it is on.
    const infra = await welcome.findByRole("radio", { name: /^infra/ });
    fireEvent.doubleClick(infra);
    await waitFor(() => expect(add).toHaveBeenCalledWith("/Users/dev/Documents/code/infra"));
    const project = await add.mock.results[0]!.value;
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/new-workspace", search: { repo: project.id } }),
    );
  });

  it("makes Open a folder… the primary action when there is no repository to pick", async () => {
    const { api, render } = load(withOnboarding({}));
    vi.spyOn(api, "listRepositories").mockResolvedValue({ repos: [] });
    render();
    const welcome = within(await screen.findByTestId("welcome"));
    const folder = await welcome.findByRole("button", { name: "Open a folder…" });
    await waitFor(() => expect(api.listRepositories).toHaveBeenCalled());
    expect(welcome.queryByRole("radiogroup", { name: "Repositories" })).toBeNull();
    expect(welcome.queryByTestId("welcome-open")).toBeNull();
    // The default button variant is the primary one; Clone is its secondary, Skip quieter still.
    expect(folder.className).toContain("bg-primary");
    expect(welcome.getByRole("button", { name: "Clone from GitHub" }).className).toContain(
      "border",
    );
  });

  it("offers a focused search once the repositories outgrow the list", async () => {
    const { api, render } = load(withOnboarding({}));
    const repos = Array.from({ length: 9 }, (_, i) => ({
      name: `repo-${i}`,
      root: `/Users/dev/code/repo-${i}`,
    }));
    vi.spyOn(api, "listRepositories").mockResolvedValue({
      repos: [...repos, { name: "billing", root: "/Users/dev/work/billing" }],
    });
    render();
    const welcome = within(await screen.findByTestId("welcome"));
    const search = await welcome.findByRole("searchbox", { name: "Find a repository" });
    expect(document.activeElement).toBe(search);
    expect(welcome.getAllByTestId("welcome-repo")).toHaveLength(6);
    expect(welcome.getByTestId("welcome-repos-more").textContent).toContain("4 more");
    fireEvent.change(search, { target: { value: "bill" } });
    expect(welcome.getAllByTestId("welcome-repo").map((row) => row.textContent)).toEqual([
      expect.stringContaining("billing"),
    ]);
    // The best match is picked, so Open and Return open it.
    expect(welcome.getByTestId("welcome-open").textContent).toContain("Open billing");
    fireEvent.change(search, { target: { value: "nope" } });
    expect(welcome.getByTestId("welcome-repos-none").textContent).toContain("nope");
    expect(welcome.queryByTestId("welcome-open")).toBeNull();
    // Escape clears the search before anything else hears it.
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
  });

  it("is skipped for good", async () => {
    const { render, updateSettings } = load(withOnboarding({}));
    render();
    const welcome = within(await screen.findByTestId("welcome"));
    fireEvent.click(welcome.getByRole("button", { name: "Skip" }));
    expect(screen.queryByTestId("welcome")).toBeNull();
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ onboarding: { welcomeSeen: true } }),
    );
  });

  it("offers a re-check, read-only, while a tool needs something", async () => {
    const { api, render, updateSettings } = load(withOnboarding({}), {
      ...ALL_READY,
      claudeSignIn: "notSignedIn",
    });
    render();
    const welcome = within(await screen.findByTestId("welcome"));
    const rows = within(await welcome.findByRole("list", { name: "Tools to set up" })).getAllByRole(
      "listitem",
    );
    // The ready agent is named in the line under Open; only the one to sign in to is listed.
    expect(welcome.getByTestId("welcome-runs-with").textContent).toBe("Runs with Codex");
    expect(rows.map((item) => item.getAttribute("data-tool"))).toEqual(["claude"]);
    const claude = rows[0];
    expect(claude?.getAttribute("data-state")).toBe("attention");
    expect(claude?.textContent).toContain("Run claude in a terminal to sign in.");
    fireEvent.click(welcome.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(api.launchChecks).toHaveBeenCalledWith(true));
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("keeps an agent another one covers to one quiet row with its install docs", async () => {
    const { api, render } = load(withOnboarding({}), {
      ...ALL_READY,
      tools: ALL_READY.tools.filter((tool) => tool.tool !== "claude"),
      claudeSignIn: "unknown",
    });
    render();
    const welcome = within(await screen.findByTestId("welcome"));
    const rows = within(await welcome.findByRole("list", { name: "Tools to set up" })).getAllByRole(
      "listitem",
    );
    const [claude] = rows;
    expect(rows).toHaveLength(1);
    expect(claude?.getAttribute("data-state")).toBe("optional");
    expect(claude?.textContent).toContain("Not installed");
    // Optional: the remedy is on its hover, not spelled out under it.
    expect(within(claude!).queryByTestId("welcome-remedy")).toBeNull();
    const install = within(claude!).getByRole("link", { name: /^Install Claude Code/ });
    expect(install.getAttribute("href")).toBe("https://docs.claude.com/en/docs/claude-code/setup");
    expect(welcome.getByTestId("welcome-runs-with").textContent).toBe("Runs with Codex");
    fireEvent.click(welcome.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(api.launchChecks).toHaveBeenCalledWith(true));
  });

  it("spells out how to install each agent while neither is ready", async () => {
    const { render } = load(withOnboarding({}), {
      ...ALL_READY,
      tools: ALL_READY.tools.filter((tool) => tool.tool !== "claude" && tool.tool !== "codex"),
      claudeSignIn: "unknown",
      codexSignIn: "notSignedIn",
    });
    render();
    const welcome = within(await screen.findByTestId("welcome"));
    const rows = within(await welcome.findByRole("list", { name: "Tools to set up" })).getAllByRole(
      "listitem",
    );
    expect(welcome.getByTestId("welcome-runs-with").getAttribute("data-ready")).toBe("false");
    expect(welcome.getByTestId("welcome-runs-with").textContent).toBe(
      "Install Claude Code or Codex to start",
    );
    expect(rows.map((row) => row.getAttribute("data-tool"))).toEqual(["claude", "codex"]);
    for (const row of rows) {
      expect(row.getAttribute("data-state")).toBe("missing");
      expect(within(row).getByTestId("welcome-remedy").textContent).toContain("npm i -g");
      expect(within(row).getByRole("link", { name: /^Install/ })).toBeTruthy();
    }
  });

  it("with no agent ready, leads with installing one and calls opening a repository setup", async () => {
    const { render } = load(withOnboarding({}), {
      ...ALL_READY,
      tools: ALL_READY.tools.filter((tool) => tool.tool !== "claude" && tool.tool !== "codex"),
      claudeSignIn: "unknown",
      codexSignIn: "notSignedIn",
    });
    render();
    const welcome = within(await screen.findByTestId("welcome"));
    await welcome.findByRole("list", { name: "Tools to set up" });
    const agents = welcome.getByTestId("welcome-agents");
    const open = welcome.getByTestId("welcome-open");
    expect(open.getAttribute("data-setup")).toBe("true");
    // The repository action only sets it up, and is no longer the filled primary.
    expect(open.textContent).toMatch(/^Set up api/);
    expect(open.className).not.toContain("bg-primary");
    // The first install is the one filled action, and the card leads the actions.
    const installs = within(agents).getAllByRole("link", { name: /^Install/ });
    expect(installs.map((link) => link.className.includes("bg-primary"))).toEqual([true, false]);
    expect(
      agents.compareDocumentPosition(welcome.getByTestId("welcome-actions")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(welcome.getByTestId("welcome-next").textContent).toContain("once an agent is ready");
  });

  it("with only a sign-in left, makes Check again the next step", async () => {
    const { render } = load(withOnboarding({}), {
      ...ALL_READY,
      tools: ALL_READY.tools.filter((tool) => tool.tool !== "codex"),
      claudeSignIn: "notSignedIn",
    });
    render();
    const welcome = within(await screen.findByTestId("welcome"));
    await waitFor(() =>
      expect(welcome.getByTestId("welcome-open").getAttribute("data-setup")).toBe("true"),
    );
    expect(welcome.getByRole("button", { name: "Check again" }).className).toContain("bg-primary");
  });

  it("says what the GitHub CLI is for while it is missing, without blocking the start", async () => {
    const { render } = load(withOnboarding({}), {
      ...ALL_READY,
      tools: ALL_READY.tools.filter((tool) => tool.tool !== "gh"),
      ghSignedIn: false,
    });
    render();
    const welcome = within(await screen.findByTestId("welcome"));
    const rows = within(await welcome.findByRole("list", { name: "Tools to set up" })).getAllByRole(
      "listitem",
    );
    expect(welcome.getByTestId("welcome-runs-with").textContent).toBe(
      "Runs with Claude Code or Codex",
    );
    expect(rows.map((row) => row.getAttribute("data-tool"))).toEqual(["gh"]);
    expect(rows[0]?.getAttribute("data-state")).toBe("optional");
    expect(rows[0]?.textContent).toContain("For pull requests");
  });

  it("shows nothing after the first run", async () => {
    const { render, updateSettings } = load(withOnboarding({ welcomeSeen: true }));
    render();
    await waitFor(() => expect(useWelcome.getState().open).toBe(false));
    expect(screen.queryByTestId("welcome")).toBeNull();
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

describe("toolRows", () => {
  const checks: LaunchChecks = {
    checkedAt: 0,
    tools: [
      { tool: "claude", found: true, version: "2.1.273" },
      { tool: "git", found: false },
      { tool: "gh", found: true, version: "2.63.0" },
      { tool: "codex", found: false, upgradeCommand: "npm i -g @openai/codex@0.154.0" },
    ],
    claudeSignIn: "notSignedIn",
    ghSignedIn: false,
  };

  it("lists the agents first, and with neither ready both say what to do", () => {
    expect(toolRows(checks).map((row) => [row.tool, row.state, row.detail])).toEqual([
      ["claude", "attention", "Not signed in. Run `claude` in a terminal to sign in."],
      [
        "codex",
        "missing",
        "Not found. Install it with `npm i -g @openai/codex@0.154.0`, then sign in with `codex login`.",
      ],
      ["git", "missing", "Not found on your login-shell PATH."],
      ["gh", "attention", "Not signed in. Run `gh auth login`."],
    ]);
    expect(canStart(toolRows(checks))).toBe(false);
  });

  it("tells someone with neither agent how to install each one", () => {
    const neither: LaunchChecks = {
      ...checks,
      claudeSignIn: "unknown",
      tools: [{ tool: "git", found: true, version: "2.47.1" }],
    };
    expect(toolRows(neither).map((row) => [row.tool, row.state, row.detail])).toEqual([
      [
        "claude",
        "missing",
        "Not found. Install it with `npm i -g @anthropic-ai/claude-code`, then sign in with `claude`.",
      ],
      [
        "codex",
        "missing",
        "Not found. Install it with `npm i -g @openai/codex`, then sign in with `codex login`.",
      ],
      ["git", "ready", "2.47.1"],
      ["gh", "optional", "Not found on your login-shell PATH."],
    ]);
    expect(canStart(toolRows(neither))).toBe(false);
  });

  it("supports a Codex-only install, with Claude Code and GitHub optional", () => {
    const onlyCodex: LaunchChecks = {
      ...checks,
      codexSignIn: "signedIn",
      tools: [
        { tool: "git", found: true, version: "2.47.1" },
        { tool: "codex", found: true, version: "0.160.0" },
      ],
    };
    const rows = toolRows(onlyCodex);
    expect(rows.map((row) => [row.tool, row.state])).toEqual([
      ["claude", "optional"],
      ["codex", "ready"],
      ["git", "ready"],
      ["gh", "optional"],
    ]);
    expect(canStart(rows)).toBe(true);
  });

  it("supports a Claude-only install, with Codex optional", () => {
    const onlyClaude: LaunchChecks = {
      ...checks,
      claudeSignIn: "signedIn",
      ghSignedIn: true,
      tools: [
        { tool: "claude", found: true, version: "2.1.273" },
        { tool: "git", found: true, version: "2.47.1" },
      ],
    };
    const rows = toolRows(onlyClaude);
    expect(rows.map((row) => [row.tool, row.state])).toEqual([
      ["claude", "ready"],
      ["codex", "optional"],
      ["git", "ready"],
      ["gh", "optional"],
    ]);
    expect(canStart(rows)).toBe(true);
  });
});

const words = (checks: LaunchChecks) => runsWith(toolRows(checks));

describe("runsWith", () => {
  const base: LaunchChecks = {
    checkedAt: 0,
    tools: [{ tool: "git", found: true, version: "2.47.1" }],
    claudeSignIn: "unknown",
    ghSignedIn: true,
  };

  it("names the ready agent, or both when both are", () => {
    const codex = {
      ...base,
      codexSignIn: "signedIn" as const,
      tools: [...base.tools, { tool: "codex" as const, found: true, version: "0.160.0" }],
    };
    expect(words(codex)).toEqual({ ready: true, agents: ["codex"], words: "Runs with Codex" });
    const both = {
      ...codex,
      claudeSignIn: "signedIn" as const,
      tools: [...codex.tools, { tool: "claude" as const, found: true, version: "2.1.273" }],
    };
    expect(words(both).words).toBe("Runs with Claude Code or Codex");
    expect(words({ ...both, tools: both.tools.filter((tool) => tool.tool !== "git") })).toEqual({
      ready: false,
      agents: ["claude", "codex"],
      words: "Runs with Claude Code or Codex once git is installed",
    });
  });

  it("says what to do first while no agent is ready", () => {
    expect(words(base)).toEqual({
      ready: false,
      agents: [],
      words: "Install Claude Code or Codex to start",
    });
    const signIn = {
      ...base,
      claudeSignIn: "notSignedIn" as const,
      tools: [...base.tools, { tool: "claude" as const, found: true, version: "2.1.273" }],
    };
    expect(words(signIn).words).toBe("Sign in to Claude Code to start");
  });
});
