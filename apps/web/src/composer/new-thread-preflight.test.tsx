// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type SelectedHarnessSupport } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { NewThreadDraft } from "./new-thread-draft";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

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
    renderWithApi(<NewThreadDraft />, api);
    await screen.findByText("Sign in with codex login, then retry.");
    expect(screen.getByLabelText("Agent").textContent).toContain("Codex");
    expect(
      (screen.getByRole("button", { name: "Create thread" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "New thread" }));
    expect(create).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalledWith(true);
    signedOut = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry check" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Create thread" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(agentSupport).toHaveBeenCalledWith(expect.objectContaining({ agent: "codex" }), {
      refresh: true,
    });
    expect(launch).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it("allows ordinary Codex with unknown account state and a strict Dream-only restriction", async () => {
    const { api, create } = setup(() => ({
      availability: { state: "unknown", reason: "Synthetic unread account status" },
    }));
    renderWithApi(<NewThreadDraft />, api);
    await screen.findByText("Unverified: Synthetic unread account status");
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Create thread" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create thread" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });
});
