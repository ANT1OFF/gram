// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type LaunchChecks, type Settings } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { prefillDraftProject } from "@/composer/draft-prefill";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { canStart, toolRows } from "./tools";
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
  it("is one screen: pick a repository, with the tools beside it", async () => {
    const { api, render, updateSettings } = load(withOnboarding({}));
    for (const profile of await api.listProfiles()) await api.removeProfile(profile.id);
    render();

    const welcome = within(await screen.findByTestId("welcome"));
    expect(welcome.getByRole("heading", { name: "Pick a repository to start" })).toBeTruthy();
    const tools = within(await welcome.findByRole("list", { name: "Tools" }));
    const rows = tools.getAllByRole("listitem");
    expect(rows.map((item) => item.getAttribute("data-tool"))).toEqual([
      "claude",
      "codex",
      "git",
      "gh",
    ]);
    expect(rows.map((item) => item.getAttribute("data-state"))).toEqual([
      "ready",
      "ready",
      "ready",
      "ready",
    ]);
    expect(welcome.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(await welcome.findByRole("button", { name: /^api/ })).toBeTruthy();
    expect(welcome.getByRole("button", { name: "Other folder" })).toBeTruthy();
    expect(welcome.getByRole("button", { name: "Clone from GitHub" })).toBeTruthy();
    // Looking at it records nothing, and a first run never asks for a gateway key.
    expect(updateSettings).not.toHaveBeenCalled();
    expect(welcome.queryByRole("form", { name: "Connect the AI gateway" })).toBeNull();
    expect(await api.listProfiles()).toEqual([]);
  });

  it("opens the new-workspace sheet on the picked repository, and stays until a workspace is made", async () => {
    const { render, updateSettings } = load(withOnboarding({}));
    render();
    const welcome = within(await screen.findByTestId("welcome"));
    fireEvent.click(await welcome.findByRole("button", { name: /^api/ }));
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
    const infra = await welcome.findByRole("button", { name: /^infra/ });
    fireEvent.click(infra);
    await waitFor(() => expect(add).toHaveBeenCalledWith("/Users/dev/Documents/code/infra"));
    const project = await add.mock.results[0]!.value;
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/new-workspace", search: { repo: project.id } }),
    );
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
    const claude = (await welcome.findByRole("list", { name: "Tools" })).querySelector(
      '[data-tool="claude"]',
    );
    expect(claude?.getAttribute("data-state")).toBe("attention");
    expect(claude?.textContent).toContain("Run claude in a terminal to sign in.");
    fireEvent.click(welcome.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(api.launchChecks).toHaveBeenCalledWith(true));
    expect(updateSettings).not.toHaveBeenCalled();
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
