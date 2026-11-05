// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type LaunchChecks, type Settings } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { prefillDraftProject } from "@/composer/draft-prefill";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { canStart, runsWith, toolRows } from "./tools";
import { useWelcome, Welcome } from "./welcome";

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
  it("is one screen: a repository to pick, the agents beside Open, and one line on what a workspace is", async () => {
    const { api, render, updateSettings } = load(withOnboarding({}));
    for (const profile of await api.listProfiles()) await api.removeProfile(profile.id);
    render();

    const welcome = within(await screen.findByTestId("welcome"));
    // It leads with the repository: the screen's heading is the pick.
    const heading = welcome.getByRole("heading", { name: "Pick a repository to start" });
    expect(screen.getByTestId("welcome").querySelector("h2")).toBe(heading);
    await waitFor(() => expect(api.launchChecks).toHaveBeenCalled());
    await vi.mocked(api.launchChecks).mock.results[0]!.value;
    expect(await welcome.findByRole("radio", { name: /^api/ })).toBeTruthy();
    // The agents' readiness sits right before the actions it gates.
    const strip = welcome.getByTestId("welcome-agents");
    expect(strip.nextElementSibling?.contains(welcome.getByTestId("welcome-open"))).toBe(true);
    // One plain line says what a workspace and its orchestrator are; the steps are optional.
    expect(welcome.getByTestId("welcome-line").textContent).toBe(
      "A workspace groups your repositories, and its orchestrator coordinates the agents that work in them.",
    );
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
    // Every agent ready: each says so, and there is nothing to re-check.
    const agents = within(await welcome.findByRole("list", { name: "Agents" })).getAllByRole(
      "listitem",
    );
    expect(agents.map((item) => item.getAttribute("data-state"))).toEqual(["ready", "ready"]);
    expect(agents.map((item) => within(item).queryByText("Ready") !== null)).toEqual([true, true]);
    expect(welcome.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(welcome.queryByRole("link", { name: /^Install/ })).toBeNull();
    // Beside Open, what its work runs on.
    expect(welcome.getByTestId("welcome-runs-with").textContent).toBe(
      "Runs with Claude Code or Codex",
    );
    // The most recent repository is picked, so the one primary action opens it; picking another
    // moves the check and the button with it.
    expect(welcome.getByRole("radio", { name: /^api/ }).getAttribute("aria-checked")).toBe("true");
    expect(welcome.getByTestId("welcome-open").textContent).toContain("Open api");
    // Three steps across the top say where each stands, and a line under Open says what it opens.
    const steps = within(welcome.getByRole("list", { name: "Steps to start" })).getAllByRole(
      "listitem",
    );
    expect(steps.map((step) => step.getAttribute("data-done"))).toEqual(["true", "true", "false"]);
    expect(steps[0]!.textContent).toContain("api");
    expect(steps[1]!.textContent).toContain("Claude Code or Codex");
    expect(steps[2]!.textContent).toContain("Opens on api");
    expect(welcome.getByTestId("welcome-next").textContent).toContain("a new workspace on api");
    fireEvent.click(welcome.getByRole("radio", { name: /^web/ }));
    expect(welcome.getByRole("radio", { name: /^web/ }).getAttribute("aria-checked")).toBe("true");
    expect(welcome.getByRole("radio", { name: /^api/ }).getAttribute("aria-checked")).toBe("false");
    expect(welcome.getByTestId("welcome-open").textContent).toContain("Open web");
    expect(steps[2]!.textContent).toContain("Opens on web");
    expect(welcome.getByRole("button", { name: "Import past CLI sessions" })).toBeTruthy();
    // The other ways in are behind one named action beside Open, not a row of their own.
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
    // Leaving the sheet with Esc comes back here; the sheet records it done.
    expect(screen.getByTestId("welcome")).toBeTruthy();
    expect(updateSettings).not.toHaveBeenCalled();
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
    // The default button variant is the primary one; beside a picked repository it is outlined.
    expect(folder.className).toContain("bg-primary");
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
    const agents = within(await welcome.findByRole("list", { name: "Agents" })).getAllByRole(
      "listitem",
    );
    // Both agents, each with its state; git only when it is missing.
    expect(agents.map((item) => item.getAttribute("data-tool"))).toEqual(["claude", "codex"]);
    expect(agents[1]?.getAttribute("data-state")).toBe("ready");
    expect(agents[1]?.textContent).toContain("Ready");
    const claude = agents[0];
    expect(claude?.getAttribute("data-state")).toBe("attention");
    expect(claude?.textContent).toContain("Run claude in a terminal to sign in.");
    fireEvent.click(welcome.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(api.launchChecks).toHaveBeenCalledWith(true));
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("gives a CLI that isn't installed a link to its install docs and a re-check", async () => {
    const { api, render } = load(withOnboarding({}), {
      ...ALL_READY,
      tools: ALL_READY.tools.filter((tool) => tool.tool !== "claude"),
      claudeSignIn: "unknown",
    });
    render();
    const welcome = within(await screen.findByTestId("welcome"));
    const agents = within(await welcome.findByRole("list", { name: "Agents" })).getAllByRole(
      "listitem",
    );
    const [claude, codex] = agents;
    expect(claude?.getAttribute("data-state")).toBe("optional");
    expect(claude?.textContent).toContain("Not installed");
    const install = within(claude!).getByRole("link", { name: /^Install Claude Code/ });
    expect(install.getAttribute("href")).toBe("https://docs.claude.com/en/docs/claude-code/setup");
    expect(codex?.textContent).toContain("Ready");
    expect(within(codex!).queryByRole("link")).toBeNull();
    expect(welcome.getByTestId("welcome-runs-with").textContent).toBe("Runs with Codex");
    fireEvent.click(within(claude!).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(api.launchChecks).toHaveBeenCalledWith(true));
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
