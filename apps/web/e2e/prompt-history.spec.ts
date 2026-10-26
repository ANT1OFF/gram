import { expect, test } from "@playwright/test";

const STORED = "Bump all minor versions and run the tests.";

test("↑ recalls the thread's stored prompts, with new sends on top", async ({ page }) => {
  await page.goto("/t/t-deps");
  const composer = page.getByRole("combobox", { name: "Message" });
  await expect(composer).toBeVisible();

  // The stored transcript's prompt, before anything is sent from this page.
  await composer.click();
  await expect(async () => {
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(STORED, { timeout: 500 });
  }).toPass();
  await composer.press("ArrowDown");
  await expect(composer).toHaveValue("");

  await composer.fill("keep the lockfile format unchanged");
  await composer.press("ControlOrMeta+Enter");
  await expect(composer).toHaveValue("");
  await composer.press("ArrowUp");
  await expect(composer).toHaveValue("keep the lockfile format unchanged");
  // A recall leaves the caret at the end: the first ↑ moves it to the start, the second recalls.
  await composer.press("ArrowUp");
  await composer.press("ArrowUp");
  await expect(composer).toHaveValue(STORED);
});
