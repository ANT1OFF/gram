// @vitest-environment happy-dom
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsPatch,
} from "@gram/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { useServerSettings } from "@/settings-sync/store";

import { ReviewBotsSection } from "./review-bots-section";

let stored: Settings;
const updateSettings = vi.fn(async (patch: SettingsPatch) => {
  stored = applySettingsPatch(stored, patch);
  return stored;
});

beforeEach(() => {
  stored = {
    ...DEFAULT_SETTINGS,
    reviewBots: [
      {
        loginPattern: "example-code-review[bot]",
        rereviewCommand: "/agent review",
        canApprove: true,
      },
    ],
  };
  updateSettings.mockClear();
  useServerSettings.setState({ settings: stored });
  render(
    <ApiProvider api={{ updateSettings } as unknown as Api}>
      <ReviewBotsSection />
    </ApiProvider>,
  );
});

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

describe("ReviewBotsSection", () => {
  it("edits an explicitly configured bot, blocks an invalid row and saves a valid list", async () => {
    const section = screen.getByTestId("review-bots");
    expect(within(section).getByLabelText<HTMLInputElement>("Login pattern").value).toBe(
      "example-code-review[bot]",
    );
    expect(within(section).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(
      true,
    );

    fireEvent.click(within(section).getByRole("button", { name: "Add bot" }));
    const second = within(section).getByRole("listitem", { name: "Review bot 2" });
    fireEvent.change(within(second).getByLabelText("Login pattern"), {
      target: { value: "copilot bot" },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));
    expect(within(second).getByRole("alert").textContent).toBe(
      "Use letters, digits, hyphens and * wildcards, optionally ending in [bot].",
    );
    expect(updateSettings).not.toHaveBeenCalled();

    fireEvent.change(within(second).getByLabelText("Login pattern"), {
      target: { value: "copilot[bot]" },
    });
    fireEvent.change(within(second).getByLabelText("Re-review command"), {
      target: { value: "@copilot review" },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        reviewBots: [
          {
            loginPattern: "example-code-review[bot]",
            rereviewCommand: "/agent review",
            canApprove: true,
          },
          { loginPattern: "copilot[bot]", rereviewCommand: "@copilot review", canApprove: false },
        ],
      }),
    );
    expect((await screen.findByRole("status")).textContent).toBe("Review bots saved.");
  });

  it("can remove every bot", async () => {
    const section = screen.getByTestId("review-bots");
    fireEvent.click(within(section).getByRole("button", { name: "Remove" }));
    expect(section.textContent).toContain("No external review bots configured");
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ reviewBots: [] }));
  });
});
