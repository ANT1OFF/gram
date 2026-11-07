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
  const rows = page
    .getByTestId("overview-sidebar")
    .locator(
      ':is([data-testid="overview-workspace-row"], [data-testid="overview-worker"], [data-testid="overview-solo"], [data-testid="overview-done"])',
    );
  // The sidebar's thread rows in order, read at each step: the mock's rows move as threads run.
  const neighbour = async (of: string, delta: 1 | -1) => {
    const ids = await rows.evaluateAll((all) =>
      all.map((row) => (row as HTMLElement).dataset.threadId ?? ""),
    );
    const at = ids.indexOf(of);
    expect(at, `${of} has a row`).toBeGreaterThanOrEqual(0);
    const id = ids[at + delta];
    expect(id, `the row ${delta === 1 ? "after" : "before"} ${of} opens a thread`).toBeTruthy();
    return id!;
  };

  await page.getByLabel("Message", { exact: true }).click();
  const next = await neighbour("t-flaky", 1);
  await page.keyboard.press("ControlOrMeta+Alt+BracketRight");
  await expect(page).toHaveURL(new RegExp(`/t/${next}$`));
  const previous = await neighbour(next, -1);
  await page.keyboard.press("ControlOrMeta+Alt+BracketLeft");
  await expect(page).toHaveURL(new RegExp(`/t/${previous}$`));

  const diff = page.getByTestId("diff-panel");
  await page.keyboard.press("ControlOrMeta+Alt+KeyB");
  await expect(page.getByTestId("right-panel")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+KeyD");
  await expect(diff).toBeVisible();
  await page.keyboard.press("ControlOrMeta+KeyD");
  await expect(diff).toBeHidden();
});
