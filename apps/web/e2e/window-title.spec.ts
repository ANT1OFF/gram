import { expect, test } from "@playwright/test";

test("the window title counts the threads that need you", async ({ page }) => {
  await page.goto("/");
  // t-question waits for an answer, t-plan for approval, and t-flaky's PR is red with changes requested.
  await expect(page).toHaveTitle("(3) Gram");

  // Parked threads don't count.
  await page.evaluate(async () => {
    for (const id of ["t-flaky", "t-question", "t-plan"]) {
      await window.gramMock?.park(id as never, true);
    }
  });
  await expect(page).toHaveTitle("Gram");

  await page.evaluate(() => window.gramMock?.park("t-plan" as never, false));
  await expect(page).toHaveTitle("(1) Gram");
  await page.evaluate(() => window.gramMock?.park("t-question" as never, false));
  await expect(page).toHaveTitle("(2) Gram");
  await page.evaluate(() => window.gramMock?.park("t-plan" as never, true));
  await expect(page).toHaveTitle("(1) Gram");
});
