// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import { renderWithRouter } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { GeneralSection } from "./general-section";

/** Renders General against `api`, with its settings in the store. */
async function renderGeneral(api: MockApi) {
  useServerSettings.setState({ settings: await api.getSettings() });
  renderWithRouter(<GeneralSection />, api);
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
}

const mockApi = () => createMockApi({ speed: 0, autoplay: false });

const radio = (group: string, name: string) =>
  within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

describe("General's launch, overview and notify rows", () => {
  it("saves Open at launch, clearing it back to Last orchestrator", async () => {
    const api = mockApi();
    await renderGeneral(api);
    expect(radio("Open at launch", "Last orchestrator").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(radio("Open at launch", "Last thread"));
    await waitFor(async () =>
      expect((await api.getSettings()).layout?.openAtLaunch).toBe("thread"),
    );
    expect(radio("Open at launch", "Last thread").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Reset Open at launch to default" }));
    await waitFor(async () =>
      expect((await api.getSettings()).layout?.openAtLaunch).toBeUndefined(),
    );
  });

  it("saves Notify me about, clearing it back to Asks and failures", async () => {
    const api = mockApi();
    await renderGeneral(api);
    expect(radio("Notify me about", "Asks and failures").getAttribute("aria-checked")).toBe("true");

    fireEvent.click(radio("Notify me about", "Asks only"));
    await waitFor(async () =>
      expect((await api.getSettings()).notifications.notifyAbout).toBe("asks"),
    );

    fireEvent.click(radio("Notify me about", "Asks and failures"));
    await waitFor(async () =>
      expect((await api.getSettings()).notifications.notifyAbout).toBeUndefined(),
    );
  });

  it("has no Layout row: the overview is the only layout", async () => {
    await renderGeneral(mockApi());
    expect(screen.queryByRole("radiogroup", { name: "Layout" })).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "Overview sidebar" })).toBeTruthy();
  });
});
