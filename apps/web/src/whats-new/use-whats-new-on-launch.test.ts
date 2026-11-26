// @vitest-environment happy-dom
import {
  DEFAULT_SETTINGS,
  RECOMMENDED,
  RECOMMENDED_HISTORY,
  recommendedChanges,
  type Diagnostics,
  type Settings,
} from "@gram/contracts";
import { cleanup, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { useWhatsNewOnLaunch } from "./use-whats-new-on-launch";
import { useWhatsNewDialog } from "./whats-new-dialog";

// Launch after an update to a synthetic version with no highlights of its own, so only the
// Recommended models line can make the screen show.

const save = vi.fn(async (_patch: unknown) => DEFAULT_SETTINGS);
const api = {
  diagnostics: async () => ({ version: "99.0.0" }) as Diagnostics,
  updateSettings: save,
};

// The first table that shipped, and what has moved in the recommendation since.
const FIRST = RECOMMENDED_HISTORY[0]!.version;
const MOVED = recommendedChanges(FIRST);

function Launch() {
  useWhatsNewOnLaunch();
  return null;
}

const launch = (agents: Partial<Settings["agents"]>) => {
  useServerSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      onboarding: { ...DEFAULT_SETTINGS.onboarding, lastSeenVersion: "98.0.0" },
      agents: { ...DEFAULT_SETTINGS.agents, ...agents },
    },
  });
  renderWithApi(createElement(Launch), api);
};

beforeEach(() => {
  save.mockClear();
  useWhatsNewDialog.setState({ releases: undefined, launch: undefined });
});

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

describe("What's New at launch with the recommended setup", () => {
  it("lists what moved since the table the user saw, then records the current one as seen", async () => {
    expect(MOVED.length).toBeGreaterThan(0);
    launch({ recommendedSetup: { enabled: true, seen: FIRST } });
    await waitFor(() => expect(save).toHaveBeenCalled());
    const shown = useWhatsNewDialog.getState().releases;
    expect(shown?.map((release) => release.version)).toEqual(["99.0.0"]);
    expect(shown?.[0]?.highlights.map((item) => item.title)).toEqual(["Recommended models"]);
    for (const line of MOVED) expect(shown?.[0]?.highlights[0]?.body).toContain(line);
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
    launch({ recommendedSetup: { enabled: false, seen: FIRST } });
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(useWhatsNewDialog.getState().releases).toBeUndefined();
    expect(save).toHaveBeenCalledWith({ onboarding: { lastSeenVersion: "99.0.0" } });
  });
});
