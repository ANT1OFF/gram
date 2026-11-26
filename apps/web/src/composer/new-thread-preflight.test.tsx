// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type SelectedHarnessSupport } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderInRouter } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { NewThreadDraft } from "./new-thread-draft";

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

const setup = (observation: () => Partial<SelectedHarnessSupport>) => {
  const api = createMockApi({
    speed: 0,
    autoplay: false,
    persist: false,
    agents: ["claude", "codex"],
  });
  const agentSupport = vi.spyOn(api, "agentSupport").mockImplementation(async (model) => ({
    model,
    checkedAt: 1,
    availability: { state: "available" },
    support: {
      session: { state: "supported", evidence: "Synthetic adapter" },
      // A Dream-only restriction must never disable the ordinary Create control.
      dreamFiles: {
        state: "unsupported",
        reason: "Synthetic strict Dream restriction",
        evidence: "Synthetic protocol",
      },
    },
    ...observation(),
  }));
  vi.spyOn(api, "listModels").mockResolvedValue({
    models: [{ id: "synthetic-model", displayName: "Synthetic model", supportsEffort: false }],
  });
  useServerSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      agents: {
        ...DEFAULT_SETTINGS.agents,
        defaultModel: { agent: "codex", model: "synthetic-model" },
        defaultFolder: "/Users/dev/Documents/code/sandbox",
      },
    },
  });
  return { api, agentSupport, create: vi.spyOn(api, "createThread") };
};

describe("new-thread preflight workflow", () => {
  it("keeps signed-out Codex selected, blocks submit and recovers through an explicit retry", async () => {
    let signedOut = true;
    const { api, agentSupport, create } = setup(() => ({
      availability: signedOut
        ? { state: "signedOut", reason: "Sign in with codex login, then retry." }
        : { state: "available" },
    }));
    const launch = vi.spyOn(api, "launchChecks");
    await renderInRouter(<NewThreadDraft />, { api });
    await screen.findByText("Sign in with codex login, then retry.");
    expect(screen.getByLabelText("Agent").textContent).toContain("Codex");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start chat" }).disabled).toBe(
      true,
    );
    fireEvent.submit(screen.getByRole("form", { name: "New thread" }));
    expect(create).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalledWith(true);
    signedOut = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry check" }));
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start chat" }).disabled).toBe(
        false,
      ),
    );
    expect(agentSupport).toHaveBeenCalledWith(expect.objectContaining({ agent: "codex" }), {
      refresh: true,
    });
    expect(launch).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it("allows ordinary Codex with unknown account state and a strict Dream-only restriction", async () => {
    const { api, create } = setup(() => ({
      availability: { state: "unknown", reason: "Synthetic unread account status" },
    }));
    await renderInRouter(<NewThreadDraft />, { api });
    await screen.findByText("Unverified: Synthetic unread account status");
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start chat" }).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it("starts in one of a headless server's projects although it refuses to browse its disk", async () => {
    const { api, create } = setup(() => ({ availability: { state: "available" } }));
    const [project] = await api.listProjects();
    useServerSettings.setState((state) => ({
      settings: {
        ...state.settings!,
        agents: { ...state.settings!.agents, defaultFolder: project!.root },
      },
    }));
    const checks = await api.launchChecks();
    vi.spyOn(api, "launchChecks").mockResolvedValue({ ...checks, headless: true });
    vi.spyOn(api, "browse").mockRejectedValue(
      new Error("not yours to change: this server's own setup comes from its deployment"),
    );
    await renderInRouter(<NewThreadDraft />, { api });
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start chat" }).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ projectRoot: project!.root });
  });
});
