import { expect, test } from "@playwright/test";

import { terminalText } from "./terminal";

test("adds a suggested script and one of its own, then runs them by click, key and palette", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const header = page.getByTestId("pane-header");

  // Nothing is saved yet, so the header keeps its room. The Terminal tab's Run script says so and
  // leads to the editor, which offers package.json's scripts.
  await expect(header.getByRole("button", { name: "Run script" })).toHaveCount(0);
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Terminal", exact: true }).click();
  // The shell's canvas mounts as it starts; opened before, the menu would lose the click to it.
  await expect(terminalText(panel.getByTestId("terminal").first())).toContainText("$");
  await panel.getByRole("button", { name: "Run script" }).click();
  const popup = page.getByTestId("run-script-popup");
  await expect(popup).toContainText("No project scripts yet.");
  await popup.getByRole("menuitem", { name: "Add project script…" }).click();

  const dialog = page.getByTestId("project-scripts-dialog");
  const suggestions = dialog.getByTestId("script-suggestion");
  await expect(suggestions.first()).toContainText("pnpm run dev");
  await expect(suggestions).toHaveCount(4);
  await dialog.getByRole("button", { name: "Add test" }).click();
  await expect(dialog.getByTestId("project-script")).toHaveCount(1);
  await expect(dialog.getByTestId("project-script")).toContainText("pnpm run test");
  await expect(suggestions).toHaveCount(3);

  // One of its own, with a key: the form records the chord pressed in the shortcut field.
  await dialog.getByTestId("add-project-script").click();
  const form = dialog.getByTestId("project-script-form");
  await form.getByLabel("Name").fill("lint strict");
  await form.getByLabel("Command").fill("pnpm run lint --max-warnings 0; exit 1");
  await form.getByTestId("script-shortcut-input").focus();
  await page.keyboard.press("ControlOrMeta+Alt+KeyL");
  await expect(form.getByTestId("script-shortcut-input")).not.toHaveValue("");
  await form.getByRole("button", { name: "Add script" }).click();
  await expect(dialog.getByTestId("project-script")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);

  // Saved, the header has Run script; a click runs it in a terminal tab named after it, green.
  await header.getByRole("button", { name: "Run script" }).click();
  const items = popup.getByTestId("run-script-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toContainText("pnpm run lint --max-warnings 0; exit 1");
  await items.filter({ hasText: "test" }).first().click();

  const tabs = panel.getByRole("tablist", { name: "Terminals" }).getByRole("tab");
  const testTab = tabs.filter({ hasText: "test" });
  await expect(testTab).toHaveCount(1);
  await expect(testTab).toHaveAttribute("data-run", "finished");
  // Beside the shell the Terminal tab opened, not in its place.
  await expect(tabs).toHaveCount(2);
  const terminal = panel.locator('[data-testid="terminal"]:not([aria-hidden="true"])');
  await expect(terminalText(terminal)).toContainText("12 checks passed");
  await expect(panel.getByRole("status")).toContainText("test finished");

  // Its key runs the other, which fails red.
  await page.keyboard.press("ControlOrMeta+Alt+KeyL");
  const lintTab = tabs.filter({ hasText: "lint strict" });
  await expect(lintTab).toHaveAttribute("data-run", "failed");
  await expect(panel.getByRole("status")).toContainText("lint strict failed with code 1");

  // From the palette, running test again reuses its tab. Off macOS a focused terminal keeps plain
  // Ctrl chords for its shell, so the palette is opened from the composer.
  await page.getByLabel("Message", { exact: true }).click();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill(">run script");
  await palette.getByRole("option", { name: /Run script…/ }).click();
  await palette.getByRole("option", { name: /^test/ }).click();
  await expect(tabs).toHaveCount(3);
  await expect(testTab).toHaveAttribute("aria-selected", "true");
  await expect(testTab).toHaveAttribute("data-run", "finished");
});
