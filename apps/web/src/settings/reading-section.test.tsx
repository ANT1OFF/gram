// @vitest-environment happy-dom
import { applySettingsPatch, DEFAULT_SETTINGS, type SettingsPatch } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { ReadingSection } from "./reading-section";

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

const setup = (reading?: { textSize?: number; width?: "narrow" | "wide" | "full" }) => {
  let settings = { ...DEFAULT_SETTINGS, ...(reading ? { reading } : {}) };
  useServerSettings.setState({ settings });
  const updateSettings = vi.fn(async (patch: SettingsPatch) => {
    settings = applySettingsPatch(settings, patch);
    return settings;
  });
  renderWithApi(<ReadingSection />, { updateSettings });
  return updateSettings;
};

const preview = () => screen.getByTestId("reading-preview").firstElementChild as HTMLElement;

describe("ReadingSection", () => {
  it("steps the text size, saves it and shows it in the preview", async () => {
    const updateSettings = setup();
    expect(screen.getByTestId("transcript-text-size").textContent).toBe("14 px");

    fireEvent.click(screen.getByRole("button", { name: "Larger transcript text" }));
    expect(preview().style.getPropertyValue("--transcript-text-size")).toBe("15px");
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith({ reading: { textSize: 15 } }),
    );
    expect(screen.getByTestId("transcript-text-size").textContent).toBe("15 px");
  });

  it("stores the default size as unset and stops at the range's ends", async () => {
    const updateSettings = setup({ textSize: 15 });
    fireEvent.click(screen.getByRole("button", { name: "Smaller transcript text" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith({ reading: { textSize: null } }),
    );

    cleanup();
    setup({ textSize: 20 });
    expect(
      (screen.getByRole("button", { name: "Larger transcript text" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("saves a width and narrows the preview's column", async () => {
    const updateSettings = setup();
    expect(screen.getByRole("radio", { name: "Comfortable" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("radio", { name: "Narrow" }));
    expect(preview().style.width).toBe("56%");
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith({ reading: { width: "narrow" } }),
    );

    fireEvent.click(screen.getByRole("radio", { name: "Comfortable" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith({ reading: { width: null } }),
    );
  });

  it("puts a changed width back to Comfortable from its reset", async () => {
    const updateSettings = setup({ width: "full" });
    fireEvent.click(screen.getByRole("button", { name: "Reset Transcript width to default" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenLastCalledWith({ reading: { width: null } }),
    );
  });
});
