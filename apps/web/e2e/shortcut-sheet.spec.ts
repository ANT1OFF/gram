import { expect, test } from "@playwright/test";

import { threadRow } from "./thread-row";

test("the shortcut sheet lists every area and filters by name, area or keys", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.click();

  await page.keyboard.press("ControlOrMeta+Slash");
  const sheet = page.getByTestId("shortcut-overlay");
  await expect(sheet).toBeVisible();
  const filter = sheet.getByLabel("Filter shortcuts");
  await expect(filter).toBeFocused();
  for (const area of ["App", "Navigation", "Thread", "Composer", "Terminal"]) {
    await expect(sheet.getByRole("region", { name: area })).toBeVisible();
  }

  await filter.fill("find");
  await expect(sheet.getByRole("region", { name: "Thread" })).toContainText("Find in thread");
  await expect(sheet.getByRole("region", { name: "Terminal" })).toContainText("Find in terminal");
  await expect(sheet.getByRole("region", { name: "Composer" })).toHaveCount(0);

  // By keys, in words.
  await filter.fill("cmd k");
  await expect(sheet.locator('[data-shortcut-id="palette.open"]')).toBeVisible();
  // By area.
  await filter.fill("terminal zoom");
  await expect(sheet.locator("[data-shortcut-id]")).toHaveCount(3);
  await filter.fill("nothing like this");
  await expect(sheet.getByTestId("shortcut-empty")).toHaveText("No matches");

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(composer).toBeFocused();

  // From the palette, opening empty again.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Go to, or > for commands").fill(">keyboard shortcuts");
  await page.keyboard.press("Enter");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("Filter shortcuts")).toHaveValue("");
});

test("next and previous thread follow the sidebar, and ⌘D shows and hides the diff", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  // The sidebar's thread rows in order, and the key pressed in the same tick: the mock's rows move
  // as its threads run, so reading them first and pressing after could disagree.
  const stepFrom = (delta: 1 | -1) =>
    page.evaluate((step) => {
      const rows = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-testid="overview-sidebar"] :is([data-testid="overview-workspace-row"], [data-testid="overview-worker"], [data-testid="overview-solo"], [data-testid="overview-done"])',
        ),
      ].map((row) => row.dataset.threadId ?? "");
      const current = location.pathname.split("/").at(-1)!;
      const expected = rows[rows.indexOf(current) + step];
      const mac = /Mac/.test(navigator.platform);
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: step === 1 ? "]" : "[",
          code: step === 1 ? "BracketRight" : "BracketLeft",
          metaKey: mac,
          ctrlKey: !mac,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      return expected;
    }, delta);

  await page.getByLabel("Message", { exact: true }).click();
  // The keys as typed, from t-flaky and back.
  await page.keyboard.press("ControlOrMeta+Alt+BracketRight");
  await expect(page).not.toHaveURL(/\/t\/t-flaky$/);
  await page.keyboard.press("ControlOrMeta+Alt+BracketLeft");
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  // Exactly the neighbours the sidebar lists at the press.
  for (const delta of [1, -1, 1] as const) {
    const expected = await stepFrom(delta);
    expect(expected, "a thread row on that side").toBeTruthy();
    await expect(page).toHaveURL(new RegExp(`/t/${expected}$`));
  }

  const diff = page.getByTestId("diff-panel");
  await page.keyboard.press("ControlOrMeta+Alt+KeyB");
  await expect(page.getByTestId("right-panel")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+KeyD");
  await expect(diff).toBeVisible();
  await page.keyboard.press("ControlOrMeta+KeyD");
  await expect(diff).toBeHidden();
});
