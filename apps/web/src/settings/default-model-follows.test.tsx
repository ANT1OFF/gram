// @vitest-environment happy-dom
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsPatch,
} from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { useServerSettings } from "@/settings-sync/store";
import { themeStore } from "@/theme/store";

import { AgentsSection } from "./agents-section";

// Settings → Agents & models with the recommended setup on (mock: recommended-setup v1, board 3):
// the default model's glyph, its effort menu ending at high, and Follow recommended once pinned.

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
}));

let stored: Settings;
const updateSettings = vi.fn(async (patch: SettingsPatch) => {
  stored = applySettingsPatch(stored, patch);
  useServerSettings.setState({ settings: stored });
  return stored;
});

const on = (defaultModel?: Settings["agents"]["defaultModel"]): Settings => ({
  ...DEFAULT_SETTINGS,
  agents: {
    ...DEFAULT_SETTINGS.agents,
    recommendedSetup: { enabled: true, seen: "synthetic" },
    ...(defaultModel === undefined ? {} : { defaultModel }),
  },
});

const show = (settings: Settings) => {
  stored = settings;
  useServerSettings.setState({ settings });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ApiProvider
        api={
          {
            updateSettings,
            listProfiles: async () => [],
            listWorkspaces: async () => [],
            // Claude alone, listing every effort up to max.
            listModels: async (agent: string) => {
              if (agent !== "claude") throw new Error("Codex isn't installed");
              return {
                models: [
                  {
                    id: "opus",
                    displayName: "Opus 5.5",
                    resolvedId: "claude-opus-5-5",
                    supportsEffort: true,
                    efforts: ["low", "medium", "high", "xhigh", "max"],
                  },
                ],
              };
            },
          } as unknown as Api
        }
      >
        <AgentsSection />
      </ApiProvider>
    </QueryClientProvider>,
  );
};

const defaultRow = () =>
  screen.getByText("Default agent and model").closest<HTMLElement>("[data-setting-row]") ??
  document.body;

beforeEach(() => {
  themeStore.setState({ motion: "off" });
  updateSettings.mockClear();
});

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

describe("The default model with the recommended setup on", () => {
  it("follows Lead, and its effort menu ends at High", async () => {
    show(on());
    const glyph = await screen.findByRole("img", {
      name: "Recommended · Lead tier · updates with Gram",
    });
    expect(glyph.dataset["follows"]).toBe("true");
    expect(within(defaultRow()).queryByRole("button", { name: "Follow recommended" })).toBeNull();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("combobox", { name: /Effort/ }));
    const options = await screen.findAllByRole("option");
    // Opus lists up to max; a following slot's menu stops at high.
    expect(
      options.map((option) => option.getAttribute("aria-label") ?? option.textContent),
    ).toEqual([
      expect.stringMatching(/^Default effort/),
      expect.stringMatching(/^Low effort/),
      expect.stringMatching(/^Medium effort/),
      expect.stringMatching(/^High effort/),
    ]);
    expect(screen.getByTestId("follow-effort-note").textContent).toBe(
      "Ends at High while it follows",
    );

    // An effort picked keeps it following, at that effort.
    await user.click(options.at(-1)!);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        agents: { defaultModel: { tier: "lead", variant: "high" } },
      }),
    );
  });

  it("marks a picked model as yours, and Follow recommended moves it back to Lead at low", async () => {
    show(on({ agent: "claude", model: "opus", variant: "max" }));
    const pin = await screen.findByRole("img", { name: "Your choice · updates leave it alone" });
    expect(pin.dataset["follows"]).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Follow recommended" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        agents: { defaultModel: { tier: "lead", variant: "low" } },
      }),
    );
    await screen.findByRole("img", { name: "Recommended · Lead tier · updates with Gram" });
  });

  it("carries no glyph while the mode is off", async () => {
    show({
      ...DEFAULT_SETTINGS,
      agents: { ...DEFAULT_SETTINGS.agents, defaultModel: { agent: "claude", model: "opus" } },
    });
    await screen.findByRole("combobox", { name: "Model" });
    expect(screen.queryByTestId("slot-glyph")).toBeNull();
    expect(screen.queryByRole("button", { name: "Follow recommended" })).toBeNull();
  });
});
