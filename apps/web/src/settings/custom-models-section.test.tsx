// @vitest-environment happy-dom
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsPatch,
} from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { CustomModelsSection } from "./custom-models-section";
import { chooseFromRowMenu } from "./row-menu-test-utils";

let stored: Settings;
const updateSettings = vi.fn(async (patch: SettingsPatch) => {
  stored = applySettingsPatch(stored, patch);
  return stored;
});

const modelSuggestions = vi.fn(async () => ({
  suggestions: [
    { agent: "claude" as const, id: "opus", source: "Claude Code settings" },
    { agent: "claude" as const, id: "claude-preview-eap", source: "Claude Code settings" },
  ],
}));
const listModels = vi.fn(async () => ({
  models: [{ id: "opus", displayName: "Claude Opus", supportsEffort: true }],
}));

const start = (settings: Settings) => {
  stored = settings;
  useServerSettings.setState({ settings: stored });
  renderWithApi(<CustomModelsSection />, { updateSettings, modelSuggestions, listModels });
};

beforeEach(() => {
  updateSettings.mockClear();
});

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

describe("CustomModelsSection", () => {
  it("adds a model, blocks a row without an id and saves a valid list", async () => {
    start(DEFAULT_SETTINGS);
    const section = screen.getByTestId("custom-models");
    const saveButton = within(section).getByRole<HTMLButtonElement>("button", { name: "Save" });
    expect(saveButton.disabled).toBe(true);

    fireEvent.click(within(section).getByRole("button", { name: "Add model" }));
    const row = within(section).getByRole("listitem", { name: "Custom model 1" });
    fireEvent.change(within(row).getByLabelText("Name"), { target: { value: "Preview" } });
    fireEvent.click(saveButton);
    expect(within(row).getByRole("alert").textContent).toBe(
      "Enter the model's id, as the agent expects it.",
    );
    expect(updateSettings).not.toHaveBeenCalled();

    fireEvent.change(within(row).getByLabelText("Model id"), {
      target: { value: " claude-preview[1m] " },
    });
    fireEvent.click(within(row).getByRole("switch", { name: "Offer reasoning effort" }));
    fireEvent.click(saveButton);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        agents: {
          customModels: [
            { agent: "claude", id: "claude-preview[1m]", name: "Preview", effort: false },
          ],
        },
      }),
    );
    // The save remounts the editor on the stored list, so `section` is a detached node by now.
    expect((await screen.findByRole("status")).textContent).toBe("Custom models saved.");
  });

  it("shows the saved models and removes one", async () => {
    start({
      ...DEFAULT_SETTINGS,
      agents: {
        ...DEFAULT_SETTINGS.agents,
        customModels: [
          { agent: "claude", id: "opus[1m]" },
          { agent: "codex", id: "gpt-preview", name: "Preview" },
        ],
      },
    });
    const section = screen.getByTestId("custom-models");
    const first = within(section).getByRole("listitem", { name: "Custom model 1" });
    // Saved models are a line each, named by their name or else their id.
    expect(first.textContent).toContain("opus[1m]");
    expect(within(first).queryByLabelText("Model id")).toBeNull();
    const second = within(section).getByRole("listitem", { name: "Custom model 2" });
    expect(second.textContent).toContain("Preview");
    expect(second.textContent).toContain("gpt-preview");

    await chooseFromRowMenu(first, "Remove");
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        agents: { customModels: [{ agent: "codex", id: "gpt-preview", name: "Preview" }] },
      }),
    );
  });

  it("offers nothing while the agent's own list is still loading", async () => {
    const pending = Promise.withResolvers<{ models: [] }>();
    listModels.mockImplementationOnce(() => pending.promise as never);
    start(DEFAULT_SETTINGS);
    await waitFor(() => expect(modelSuggestions).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("model-suggestions")).toBeNull();
    pending.resolve({ models: [] });
    expect(await screen.findByRole("button", { name: "Add opus" })).toBeTruthy();
  });

  it("offers a model found in Claude Code's settings as a row to add, once", async () => {
    start(DEFAULT_SETTINGS);
    const add = await screen.findByRole("button", { name: "Add claude-preview-eap" });
    // The agent lists `opus` itself, so that one needs no row.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add opus" })).toBeNull());

    fireEvent.click(add);
    const section = screen.getByTestId("custom-models");
    const row = within(section).getByRole("listitem", { name: "Custom model 1" });
    expect(within(row).getByLabelText<HTMLInputElement>("Model id").value).toBe(
      "claude-preview-eap",
    );
    expect(screen.queryByRole("button", { name: "Add claude-preview-eap" })).toBeNull();

    fireEvent.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        agents: { customModels: [{ agent: "claude", id: "claude-preview-eap" }] },
      }),
    );
  });
});
