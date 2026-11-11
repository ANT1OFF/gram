// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, RECOMMENDED, type Settings } from "@gram/contracts";
import type * as Contracts from "@gram/contracts";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useServerSettings } from "@/settings-sync/store";

import { useWhatsNewOnLaunch } from "./use-whats-new-on-launch";
import { useWhatsNewDialog } from "./whats-new-dialog";

// Launch after an update to a synthetic version with no highlights of its own, so only the
// Recommended models line can make the screen show.

const save = vi.fn(async (_patch: unknown) => DEFAULT_SETTINGS);
vi.mock("@/settings/use-save-settings", () => ({ useSaveSettings: () => save }));
vi.mock("@/settings/use-diagnostics", () => ({
  useDiagnostics: () => ({ data: { version: "99.0.0" } }),
}));

// Only one table has shipped, so a change is staged: the table seen as "2026.01" moved Scoped.
const MOVED = ["Scoped on Codex: gpt-6.1-sol · medium → gpt-6.2-sol · medium"];
vi.mock("@gram/contracts", async (actual) => {
  const contracts = await actual<typeof Contracts>();
  return {
    ...contracts,
    recommendedChanges: (seen: string | undefined) => (seen === "2026.01" ? MOVED : []),
  };
});

const launch = (agents: Partial<Settings["agents"]>) => {
  useServerSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      onboarding: { ...DEFAULT_SETTINGS.onboarding, lastSeenVersion: "98.0.0" },
      agents: { ...DEFAULT_SETTINGS.agents, ...agents },
    },
  });
  renderHook(() => useWhatsNewOnLaunch());
};

beforeEach(() => {
  save.mockClear();
  useWhatsNewDialog.setState({ releases: undefined, launch: undefined });
});

afterEach(() => {
  useServerSettings.setState({ settings: undefined });
});

describe("What's New at launch with the recommended setup", () => {
  it("lists what moved since the table the user saw, then records the current one as seen", async () => {
    launch({ recommendedSetup: { enabled: true, seen: "2026.01" } });
    await waitFor(() => expect(save).toHaveBeenCalled());
    const shown = useWhatsNewDialog.getState().releases;
    expect(shown?.map((release) => release.version)).toEqual(["99.0.0"]);
    expect(shown?.[0]?.highlights.map((item) => item.title)).toEqual(["Recommended models"]);
    expect(shown?.[0]?.highlights[0]?.body).toContain(MOVED[0]);
    expect(save).toHaveBeenCalledWith({
      onboarding: { lastSeenVersion: "99.0.0" },
      agents: { recommendedSetup: { enabled: true, seen: RECOMMENDED.version } },
    });
  });

  it("says nothing when nothing moved since the table the user saw", async () => {
    launch({ recommendedSetup: { enabled: true, seen: RECOMMENDED.version } });
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(useWhatsNewDialog.getState().releases).toBeUndefined();
    expect(save).toHaveBeenCalledWith({ onboarding: { lastSeenVersion: "99.0.0" } });
  });

  it("says nothing of the recommendation while the mode is off", async () => {
    launch({ recommendedSetup: { enabled: false, seen: "2026.01" } });
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(useWhatsNewDialog.getState().releases).toBeUndefined();
    expect(save).toHaveBeenCalledWith({ onboarding: { lastSeenVersion: "99.0.0" } });
  });
});
