import { expect, test, type Page } from "@playwright/test";

import { slowdown } from "./slowdown";
import { threadRow } from "./thread-row";

/**
 * Opens the row menu's PR submenu and waits for `item`. The submenu opens on hover, so a click on
 * its trigger can close it again; a row re-rendering after a bind can also detach the open menu.
 */
async function openPrSubmenu(page: Page, item: string, select = false) {
  const row = threadRow(page, "t-flaky");
  await expect(async () => {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await row.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "PR", exact: true })
      .hover({ timeout: 2_000 * slowdown });
    await expect(page.getByRole("menuitem", { name: item })).toBeVisible({
      timeout: 2_000 * slowdown,
    });
    if (select) {
      // Include selection in the retry: a row moving between activity lanes closes its portal.
      await page.getByRole("menuitem", { name: item }).click({ timeout: 2_000 * slowdown });
    }
  }).toPass({ timeout: 15_000 * slowdown });
}

test("binds and unbinds a PR from the row menu and ⌘K", async ({ page }) => {
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();

  await openPrSubmenu(page, "Bind PR…", true);
  const dialog = page.getByTestId("bind-pr-dialog");
  await dialog.getByLabel("Pull request number or URL").fill("#412");
  await dialog.getByRole("button", { name: "Bind" }).click();
  await expect(dialog).toBeHidden();

  await openPrSubmenu(page, "Unbind #412");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill(">Unbind");
  await palette.getByRole("combobox").press("Enter");
  await expect(palette).toBeHidden();

  await openPrSubmenu(page, "Bind PR…");
});

test("picks a notification sound in Settings → Notifications", async ({ page }) => {
  await page.goto("/settings/notifications");
  const section = page.getByTestId("notification-settings");
  const sounds = section.getByRole("radiogroup", { name: "Notification sound" });
  await expect(sounds.getByRole("radio", { name: "Chime" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await section.getByRole("button", { name: "Preview Bell" }).click();
  await sounds.getByRole("radio", { name: "Bell" }).click();
  await expect(sounds.getByRole("radio", { name: "Bell" })).toHaveAttribute("aria-checked", "true");

  await page.reload();
  await expect(
    page.getByTestId("notification-settings").getByRole("radio", { name: "Bell" }),
  ).toHaveAttribute("aria-checked", "true");
});
