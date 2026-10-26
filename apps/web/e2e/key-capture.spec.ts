import { expect, test } from "@playwright/test";

import { openAdvancedPage } from "./settings-nav";

const J = /⌘⇧J|Ctrl\+Shift\+J/;

test("records a shortcut, takes another action's keys, and cancels on Escape", async ({ page }) => {
  await page.goto("/t/t-deps");
  await expect(page.getByTestId("pane-header")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await openAdvancedPage(page, "Keyboard");
  const settings = page.getByTestId("keyboard-settings");
  const dialog = page.getByTestId("key-capture-dialog");
  const status = dialog.getByTestId("key-capture-status");

  const sidebar = settings.getByTestId("binding-sidebar.toggle");
  await sidebar.getByRole("button", { name: "Change Collapse / expand sidebar" }).click();
  await expect(status).toContainText("Recording");
  await page.keyboard.press("ControlOrMeta+Shift+j");
  await expect(status).toContainText(J);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(sidebar).toContainText("custom");
  await expect(sidebar).toContainText(J);

  const panel = settings.getByTestId("binding-panel.toggle");
  await panel.getByRole("button", { name: "Change Show / hide right panel" }).click();
  await page.keyboard.press("ControlOrMeta+Shift+j");
  await expect(dialog.getByTestId("key-capture-clash")).toContainText(
    "Same keys as Collapse / expand sidebar",
  );
  await dialog.getByRole("button", { name: "Replace" }).click();
  await expect(dialog).toBeHidden();
  await expect(panel).toContainText(J);
  await expect(sidebar).toContainText("Off");

  const focus = settings.getByTestId("binding-focus.toggle");
  await focus.getByRole("button", { name: "Change Focus mode" }).click();
  await expect(status).toContainText("Recording");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(focus).not.toContainText("custom");

  await settings.getByRole("button", { name: "Reset all" }).click();
  await expect(sidebar).not.toContainText("custom");
  await expect(panel).not.toContainText("custom");
});
