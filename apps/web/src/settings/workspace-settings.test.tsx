// @vitest-environment happy-dom
import {
  DEFAULT_CHARTER,
  DEFAULT_SETTINGS,
  type OrchestratorCharter,
  type ProjectId,
  type Settings,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithRouter } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { WorkspaceSettingsPage } from "./workspace-page";
import { WorkspacesSettings } from "./workspace-settings";

beforeEach(() => {
  vi.spyOn(console, "warn");
  vi.spyOn(console, "error");
});
afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
  try {
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

const renderToggle = (settings: Settings) => {
  useServerSettings.setState({ settings });
  return renderWithRouter(<WorkspacesSettings />, {
    diagnostics: async () => ({}) as never,
    listWorkspaces: async () => [],
    listProjects: async () => [],
  });
};

const chosen = (value: boolean): Settings => ({
  ...DEFAULT_SETTINGS,
  workspaces: { continueAfterRestart: value },
});

const toggle = async () =>
  (await screen.findByRole("switch", { name: "Resume workers on restart" })).getAttribute(
    "aria-checked",
  );

describe("Resume workers on restart", () => {
  it("opens the new workspace route from the settings action", async () => {
    const { router } = renderToggle(DEFAULT_SETTINGS);
    fireEvent.click(await screen.findByRole("button", { name: "New workspace…" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/new-workspace"));
  });
  it("defaults off", async () => {
    renderToggle(DEFAULT_SETTINGS);
    await screen.findByRole("switch", { name: "Resume workers on restart" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await toggle()).toBe("false");
  });

  it("shows an explicit choice", async () => {
    renderToggle(chosen(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await toggle()).toBe("false");
    cleanup();
    renderToggle(chosen(true));
    expect(await toggle()).toBe("true");
  });
});

describe("Message other sessions", () => {
  const name = "Message other sessions";
  it("is off by default and saves the user's choice", async () => {
    const updateSettings = vi.fn(async (patch: { workspaces?: object }) => ({
      ...DEFAULT_SETTINGS,
      workspaces: { ...patch.workspaces },
    }));
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    renderWithRouter(<WorkspacesSettings />, {
      diagnostics: async () => ({}) as never,
      listWorkspaces: async () => [],
      listProjects: async () => [],
      updateSettings,
    });
    const peer = await screen.findByRole("switch", { name });
    expect(peer.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(peer);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        workspaces: { orchestratorPeerMessaging: true },
      }),
    );
    await waitFor(async () =>
      expect((await screen.findByRole("switch", { name })).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
  });
});

const dream = () => screen.findByRole("switch", { name: "Dream automatically" });

describe("a workspace charter save", () => {
  const workspace: WorkspaceState = {
    workspace: {
      id: "w1" as WorkspaceId,
      name: "Shop",
      projectIds: ["p1" as ProjectId],
      homeProjectId: "p1" as ProjectId,
      createdAt: 1,
    },
    charter: DEFAULT_CHARTER,
  };
  it("shows the change while it saves and the saved charter once it is refused", async () => {
    let refuse: ((error: Error) => void) | undefined;
    const setOrchestratorCharter = vi.fn(
      (_id: WorkspaceId, _charter: OrchestratorCharter) =>
        new Promise<never>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    useServerSettings.setState({
      settings: { ...DEFAULT_SETTINGS },
    });
    renderWithRouter(<WorkspaceSettingsPage workspaceId={workspace.workspace.id} />, {
      listWorkspaces: async () => [workspace],
      listProjects: async () => [],
      automaticDreamStatus: async () => ({ threshold: 10, completed: 0, detail: "Waiting." }),
      setOrchestratorCharter,
    });
    // Dream sits under Advanced on the workspace's own page.
    fireEvent.click(await screen.findByTestId("workspace-advanced"));
    expect((await dream()).getAttribute("aria-checked")).toBe("false");

    fireEvent.click(await dream());
    expect(setOrchestratorCharter).toHaveBeenCalledWith("w1", {
      ...DEFAULT_CHARTER,
      automaticDreamThreshold: 10,
    });
    // Before the save answers, the switch and its threshold already show the choice.
    expect((await dream()).getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByRole("spinbutton", { name: "Completed threads before Dream" }),
    ).toHaveProperty("value", "10");

    refuse?.(new Error("Charter refused."));
    await waitFor(async () => expect((await dream()).getAttribute("aria-checked")).toBe("false"));
    expect(await screen.findByText("Charter refused.")).toBeTruthy();
  });
});
