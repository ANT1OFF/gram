// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type AgentKind } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { AgentsSection } from "@/settings/agents-section";
import { DiagnosticsSection } from "@/settings/diagnostics-section";
import { useServerSettings } from "@/settings-sync/store";

import { NewThreadDraft } from "./new-thread-draft";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
}));

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

const offered = {
  models: [
    { id: "codex-default", displayName: "Codex default", supportsEffort: false, isDefault: true },
  ],
};

function ChooserAndDiagnostics({ chooser }: { chooser: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(!open)}>{open ? "Close chooser" : "Open chooser"}</button>
      {open ? chooser : <DiagnosticsSection />}
    </>
  );
}

describe.each([
  ["Settings", AgentsSection],
  ["new thread", NewThreadDraft],
] as const)("%s default discovery composition", (_name, Component) => {
  it("settles initial failures without mounting another automatic discovery attempt", async () => {
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    const api = createMockApi({ speed: 0, autoplay: false });
    const calls: AgentKind[] = [];
    const listing = vi.spyOn(api, "listModels").mockImplementation(async (agent) => {
      calls.push(agent);
      // Bound the regression on the old remount loop, without masking the extra probes.
      if (agent === "claude" && calls.filter((a) => a === "claude").length >= 5) return offered;
      throw new Error(`${agent} is unavailable`);
    });
    const save = vi.spyOn(api, "updateSettings");
    renderWithApi(<Component />, api);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Agent" })).toBeTruthy());
    // Allow query observer mount notifications to run after the discovery placeholder disappears.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(listing.mock.calls.filter(([agent]) => agent === "claude")).toHaveLength(1);
    expect(listing.mock.calls.filter(([agent]) => agent === "codex")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Retry models" })).toBeTruthy();
    expect(screen.queryByText("Discovering local agents…")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps the chooser mounted during an explicit retry and uses recovered discovery", async () => {
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    const api = createMockApi({ speed: 0, autoplay: false });
    const recovery = Promise.withResolvers<void>();
    let retrying = false;
    let recovered = false;
    const listing = vi.spyOn(api, "listModels").mockImplementation(async (agent) => {
      if (retrying && (agent === "claude" || agent === "codex")) await recovery.promise;
      if (recovered && agent === "codex") return offered;
      throw new Error(`${agent} is unavailable`);
    });
    const checks = vi.spyOn(api, "launchChecks");
    const save = vi.spyOn(api, "updateSettings");
    renderWithApi(<Component />, api);
    const retry = await screen.findByRole("button", { name: "Retry models" });
    retrying = true;
    fireEvent.click(retry);
    await waitFor(() =>
      expect(listing.mock.calls.filter(([agent]) => agent === "claude")).toHaveLength(2),
    );
    expect(checks).toHaveBeenCalledWith(true);
    expect(screen.getByRole("combobox", { name: "Agent" })).toBeTruthy();
    expect(screen.queryByText("Discovering local agents…")).toBeNull();
    await act(async () => recovery.resolve());
    const retryAgain = await screen.findByRole("button", { name: "Retry models" });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(listing.mock.calls.filter(([agent]) => agent === "claude")).toHaveLength(2);
    expect(listing.mock.calls.filter(([agent]) => agent === "codex")).toHaveLength(2);
    recovered = true;
    fireEvent.click(retryAgain);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Agent" }).textContent).toContain("Codex"),
    );
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Codex default");
    expect(listing.mock.calls.filter(([agent]) => agent === "claude")).toHaveLength(3);
    expect(listing.mock.calls.filter(([agent]) => agent === "codex")).toHaveLength(3);
    expect(save).not.toHaveBeenCalled();
  });

  it("retains an explicit signed-out Claude selection without probing Codex as a fallback", async () => {
    useServerSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        agents: {
          ...DEFAULT_SETTINGS.agents,
          defaultModel: {
            agent: "claude",
            model: "chosen-model",
            variant: "high",
            speed: "standard",
          },
        },
      },
    });
    const api = createMockApi({ speed: 0, autoplay: false });
    const listing = vi.spyOn(api, "listModels").mockImplementation(async (agent) => {
      if (agent === "codex") return offered;
      throw new Error(`${agent} is signed out`);
    });
    renderWithApi(<Component />, api);
    const retry = await screen.findByRole("button", { name: "Retry models" });
    fireEvent.click(retry);
    await waitFor(() =>
      expect(listing.mock.calls.filter(([agent]) => agent === "claude")).toHaveLength(2),
    );
    expect(await screen.findByRole("button", { name: "Retry models" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Agent" }).textContent).toContain("Claude");
    expect(listing.mock.calls.filter(([agent]) => agent === "codex")).toHaveLength(0);
    expect(useServerSettings.getState().settings?.agents.defaultModel).toEqual({
      agent: "claude",
      model: "chosen-model",
      variant: "high",
      speed: "standard",
    });
  });

  it.each(["claude", "codex"] as const)(
    "recovers an inactive failed %s listing through explicit Diagnostics Recheck",
    async (agent) => {
      useServerSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          agents: {
            ...DEFAULT_SETTINGS.agents,
            defaultModel: { agent, model: "chosen-model", variant: "high", speed: "standard" },
          },
        },
      });
      let signedIn = false;
      const api = createMockApi({ speed: 0, autoplay: false });
      const listing = vi.spyOn(api, "listModels").mockImplementation(async (requested) => {
        if (requested !== agent || !signedIn) throw new Error(`${requested} is signed out`);
        return {
          models: [
            { id: "chosen-model", displayName: "Recovered account model", supportsEffort: true },
          ],
        };
      });
      const checks = vi.spyOn(api, "launchChecks");
      const save = vi.spyOn(api, "updateSettings");
      renderWithApi(<ChooserAndDiagnostics chooser={<Component />} />, api);
      await screen.findByRole("button", { name: "Retry models" });
      fireEvent.click(screen.getByRole("button", { name: "Close chooser" }));
      const recheck = await screen.findByRole("button", { name: "Re-check" });
      expect(listing.mock.calls.filter(([requested]) => requested === agent)).toHaveLength(1);
      signedIn = true;
      fireEvent.click(recheck);
      await waitFor(() => expect(checks).toHaveBeenCalledWith(true));
      await waitFor(() => expect(recheck.getAttribute("aria-busy")).toBe("false"));
      expect(listing.mock.calls.filter(([requested]) => requested === agent)).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Open chooser" }));
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain(
          "Recovered account model",
        ),
      );
      expect(listing.mock.calls.filter(([requested]) => requested === agent)).toHaveLength(2);
      expect(
        listing.mock.calls.filter(
          ([requested]) => requested === (agent === "claude" ? "codex" : "claude"),
        ),
      ).toHaveLength(0);
      expect(screen.getByRole("combobox", { name: "Agent" }).textContent).toContain(
        agent === "claude" ? "Claude" : "Codex",
      );
      expect(screen.queryByRole("button", { name: "Retry models" })).toBeNull();
      expect(save).not.toHaveBeenCalled();
      expect(useServerSettings.getState().settings?.agents.defaultModel).toEqual({
        agent,
        model: "chosen-model",
        variant: "high",
        speed: "standard",
      });
    },
  );
});
