import { expect, test, type Page } from "@playwright/test";
import { layoutButton } from "./layout";

// Checks Glass, the only look, renders its structural treatment, the grid holds at every preset, and
// the overview sidebar and focus mode still lay out. Screenshots for review go to
// e2e/__screenshots__/looks/ (gitignored; they change every run).

const SETTINGS_KEY = "gram.mock.settings";

/**
 * Picks the mode and motion in Settings → Appearance, as a user would. Glass is the only look. The
 * mock keeps settings in sessionStorage, so later navigations in the tab keep them.
 */
async function useLook(page: Page, look: "glass", mode: "dark" | "light") {
  await page.goto("/settings/appearance");
  await page.getByRole("group", { name: "Mode" }).getByRole("button", { name: mode }).click();
  await page.getByRole("group", { name: "Motion" }).getByRole("button", { name: "off" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-look", look);
  await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
  // Wait for the debounced settings push, so the next page load starts in this look.
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key) ?? "{}").appearance,
        SETTINGS_KEY,
      ),
    )
    .toMatchObject({ look, mode, motion: "off" });
}

const style = (page: Page, selector: string, property: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/__screenshots__/looks/${name}.png` });

for (const [look, mode] of [["glass", "dark"]] as const) {
  test(`${look} (${mode}) renders its structure and holds the grid`, async ({ page }) => {
    await useLook(page, look, mode);
    await page.goto("/t/t-flaky");
    await expect(page.locator("html")).toHaveAttribute("data-look", look);
    await expect(page.getByTestId("approval-card")).toBeVisible({ timeout: 20_000 });
    await shot(page, `${look}-${mode}-thread`);

    expect(await style(page, '[data-testid="right-panel"]', "backdrop-filter")).toContain("blur");
    expect(await style(page, "body", "background-image")).toContain("radial-gradient");

    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await shot(page, `${look}-${mode}-palette`);
    await page.keyboard.press("Escape");

    const picker = layoutButton(page);
    const presets = page.getByRole("radiogroup", { name: "Layout" }).getByRole("radio");
    await picker.click();
    const count = await presets.count();
    expect(count).toBe(6);
    for (let i = 0; i < count; i++) {
      if (i > 0) await picker.click();
      await presets.nth(i).click();
      await expect(page.getByTestId("pane").first()).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `preset ${i} overflows`).toBeLessThanOrEqual(0);
      const narrow = await page
        .getByTestId("pane")
        .evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().width < 120).length);
      expect(narrow, `preset ${i} has a collapsed pane`).toBe(0);
    }
    await shot(page, `${look}-${mode}-grid-3c2r`);
    await picker.click();
    await presets.nth(0).click();

    // Hidden, the overview leaves a Show sidebar button in the title bar.
    await page.keyboard.press("ControlOrMeta+b");
    await expect(page.getByTestId("overview-sidebar")).toBeHidden();
    await expect(page.getByTestId("overview-show")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+b");
    await expect(page.getByTestId("overview-sidebar")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+.");
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-focus-mode", "true");
    await shot(page, `${look}-${mode}-focus`);
    await page.keyboard.press("ControlOrMeta+Shift+.");
  });
}

test("the /new prompt box takes the look's composer treatment, as the thread's does", async ({
  page,
}) => {
  const slab = '[data-surface="composer"]';
  await useLook(page, "glass", "dark");
  await page.goto("/new");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await style(page, slab, "border-top-left-radius")).toBe("22px");
});
