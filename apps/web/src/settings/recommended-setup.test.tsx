// @vitest-environment happy-dom
import {
  applySettingsPatch,
  DEFAULT_CHARTER,
  DEFAULT_SETTINGS,
  RECOMMENDED,
  type AgentKind,
  type OrchestratorCharter,
  type Settings,
  type SettingsPatch,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { useServerSettings } from "@/settings-sync/store";
import { themeStore } from "@/theme/store";

import { RecommendedSetupRow } from "./recommended-setup";

const efforts = ["low", "medium", "high"] as const;
let stored: Settings;
const updateSettings = vi.fn(async (patch: SettingsPatch) => {
  stored = applySettingsPatch(stored, patch);
  return stored;
});
const setOrchestratorCharter = vi.fn(async (_id: WorkspaceId, _charter: OrchestratorCharter) => {});
const shop: WorkspaceState = {
  workspace: {
    id: "Shop" as WorkspaceId,
    name: "Shop",
    projectIds: ["p" as never],
    homeProjectId: "p" as never,
    createdAt: 1,
  },
  charter: {
    ...DEFAULT_CHARTER,
    orchestratorModel: { agent: "claude", model: "opus", variant: "high", speed: "standard" },
  },
};
const api = {
  updateSettings,
  setOrchestratorCharter,
  listWorkspaces: async () => [shop],
  listModels: async (agent: AgentKind) => ({
    models:
      agent === "claude"
        ? [
            {
              id: "opus",
              displayName: "Opus",
              supportsEffort: true,
              efforts,
              resolvedId: "claude-opus-5-5",
            },
            {
              id: "haiku",
              displayName: "Haiku",
              supportsEffort: true,
              efforts,
              resolvedId: "claude-haiku-5-5",
            },
          ]
        : [{ id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", supportsEffort: true, efforts }],
  }),
} as unknown as Api;

const view = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ApiProvider api={api}>
        <RecommendedSetupRow />
      </ApiProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  themeStore.setState({ motion: "off" });
  stored = DEFAULT_SETTINGS;
  updateSettings.mockClear();
  setOrchestratorCharter.mockClear();
  useServerSettings.setState({ settings: stored });
});
afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

describe("the Recommended setup row", () => {
  it("turning it on asks once, with Gram's past defaults ticked, and writes what was ticked", async () => {
    view();
    fireEvent.click(screen.getByTestId("recommended-setup-switch"));
    const sheet = await screen.findByTestId("recommended-turn-on");
    await waitFor(() =>
      expect(
        screen.getAllByTestId("recommended-turn-on-row").map((row) => row.dataset["key"]),
      ).toContain("orchestrator:Shop"),
    );
    expect(sheet.textContent).toContain(
      "Claude Code opus · High → Recommended Lead · Opus 5.5 · Medium",
    );
    await waitFor(() =>
      expect(screen.getByTestId<HTMLButtonElement>("recommended-turn-on-confirm").disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByTestId("recommended-turn-on-confirm"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(stored.agents.recommendedSetup).toEqual({ enabled: true, seen: RECOMMENDED.version });
    expect(setOrchestratorCharter).toHaveBeenCalledWith(
      "Shop",
      expect.objectContaining({ orchestratorModel: { tier: "lead" } }),
    );
    // On: this machine's summary, and the tiers under Details.
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Opus 5.5 leads, GPT-6.1-Sol does scoped work, Haiku 5.5 helps.",
      ),
    );
  });

  it("once confirmed, turns back on without the sheet", async () => {
    stored = {
      ...DEFAULT_SETTINGS,
      agents: { ...DEFAULT_SETTINGS.agents, recommendedSetup: { enabled: false, seen: "2026.11" } },
    };
    useServerSettings.setState({ settings: stored });
    view();
    fireEvent.click(screen.getByTestId("recommended-setup-switch"));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        agents: { recommendedSetup: { enabled: true, seen: "2026.11" } },
      }),
    );
    expect(screen.queryByTestId("recommended-turn-on")).toBeNull();
  });

  it("turning it off asks, and Keep current models pins what follows", async () => {
    stored = {
      ...DEFAULT_SETTINGS,
      agents: { ...DEFAULT_SETTINGS.agents, recommendedSetup: { enabled: true, seen: "2026.11" } },
    };
    useServerSettings.setState({ settings: stored });
    view();
    fireEvent.click(screen.getByTestId("recommended-setup-switch"));
    await screen.findByTestId("recommended-turn-off");
    // Wait for the lists, so what follows can be pinned to what it runs on.
    await waitFor(() => expect(document.body.textContent).toContain("Opus 5.5 leads"));
    fireEvent.click(screen.getByTestId("recommended-turn-off-keep"));
    await waitFor(() => expect(stored.agents.recommendedSetup?.enabled).toBe(false));
    expect(stored.agents.defaultModel).toEqual({
      agent: "claude",
      model: "opus",
      variant: "low",
      speed: "standard",
    });
  });
});
