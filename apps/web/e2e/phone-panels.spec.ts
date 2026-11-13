import { expect, test } from "@playwright/test";

// A phone has no room for a thread's panels beside its chat: a row under the title names them, and
// an open panel names itself and its thread, with Back to the thread.
test.describe("a thread's panels on a phone", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("the row under the title opens a panel, and its header leads back", async ({ page }) => {
    await page.goto("/t/t-deps");
    await expect(page.getByTestId("transcript")).toBeVisible();
    const row = page.getByTestId("phone-panel-row");
    await expect(row.getByTestId("phone-panel-chat")).toHaveAttribute("aria-current", "page");
    for (const name of ["Diff", "PR", "Files", "Terminal"]) {
      await expect(row.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    const bounds = await row.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);

    await row.getByTestId("phone-panel-files").tap();
    const header = page.getByTestId("phone-panel-header");
    await expect(header.getByRole("heading")).toHaveText("Files");
    await expect(header.getByTestId("phone-panel-thread")).not.toBeEmpty();
    await expect(page.locator('[data-panel-tab="files"]')).toHaveAttribute("aria-selected", "true");
    // The panel covers the chat, so the row is out of reach until Back.
    await expect(row).toHaveCount(0);

    await header.getByRole("button", { name: "Back to the thread" }).tap();
    await expect(page.getByTestId("right-panel")).toHaveCount(0);
    await expect(page.getByTestId("phone-panel-row")).toBeVisible();
  });

  test("a page without a thread has no row", async ({ page }) => {
    await page.goto("/threads");
    await page.getByTestId("app-shell").waitFor();
    await expect(page.getByTestId("phone-panel-row")).toHaveCount(0);
  });
});
