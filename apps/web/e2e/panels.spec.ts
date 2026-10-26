import { expect, test } from "@playwright/test";
import { layoutButton } from "./layout";

test("collapses the sidebar, hides the right panel, focus mode, and reload restores", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  const sidebar = page.getByTestId("overview-sidebar");
  // Hidden, the overview leaves a Show sidebar button in the title bar.
  const show = page.getByTestId("overview-show");
  const panel = page.getByTestId("right-panel");
  await expect(sidebar).toBeVisible();
  await expect(panel).toBeVisible();

  await page.keyboard.press("ControlOrMeta+b");
  await expect(show).toBeVisible();
  await expect(sidebar).toBeHidden();
  await page.keyboard.press("ControlOrMeta+Alt+b");
  await expect(panel).toBeHidden();
  await expect(page.getByTestId("thread-view")).toBeVisible();

  // Let the debounced settings save land before reloading.
  await page.waitForTimeout(1200);
  // Drop the first-paint cache so only the saved settings can restore the panels.
  await page.evaluate(() => window.localStorage.removeItem("gram.layout"));
  await page.reload();
  await expect(show).toBeVisible();
  await expect(sidebar).toBeHidden();
  await expect(panel).toBeHidden();

  await show.click();
  await expect(sidebar).toBeVisible();
  await page.getByRole("button", { name: "Show right panel" }).click();
  await expect(panel).toBeVisible();

  // Focus mode hides the overview; the title bar keeps its Show sidebar, as for a hidden overview.
  await page.keyboard.press("ControlOrMeta+Shift+Period");
  await expect(sidebar).toBeHidden();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId("thread-view")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Shift+Period");
  await expect(sidebar).toBeVisible();
  await expect(panel).toBeVisible();
});

test("hiding the right panel keeps the titlebar's buttons clear of Windows' window controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/t/t-deps");
  // Chromium only fills `env(titlebar-area-*)` under a title bar overlay, so stand in for the 138 px
  // Electron's Windows controls take.
  const controls = 138;
  await page.evaluate((inset) => {
    document.documentElement.style.setProperty("--window-controls-inset", `${inset}px`);
  }, controls);
  const panel = page.getByTestId("right-panel");
  const main = page.getByRole("main");
  const layout = layoutButton(page);
  await expect(panel).toBeVisible();

  for (let round = 0; round < 2; round += 1) {
    await page.getByRole("button", { name: "Hide right panel" }).click();
    await expect(panel).toBeHidden();
    const show = page.getByRole("button", { name: "Show right panel" });
    await expect(show).toBeVisible();
    // The chat takes the panel's width, and nothing it shows sits under the controls.
    await expect
      .poll(async () => {
        const box = await main.boundingBox();
        return box === null ? 0 : Math.round(box.x + box.width);
      })
      .toBe(1200);
    for (const button of [show, layout]) {
      const box = await button.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(1200 - controls);
    }

    await show.click();
    await expect(panel).toBeVisible();
    // Beside the panel, the titlebar ends at the chat's edge again.
    const hide = await page.getByRole("button", { name: "Hide right panel" }).boundingBox();
    const chat = await main.boundingBox();
    expect(chat!.x + chat!.width - (hide!.x + hide!.width)).toBeLessThan(controls);
  }
});
