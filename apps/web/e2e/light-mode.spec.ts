import { expect, test } from "@playwright/test";

import { seedTheme } from "./seed-theme";

// Renders the scripted thread in the light palettes and captures screenshots for review into
// e2e/__screenshots__/ (gitignored; they change every run).
for (const palette of ["tokyo-light", "catppuccin-latte"]) {
  test(`renders the scripted thread in ${palette}`, async ({ page }) => {
    await seedTheme(page, { palette, mode: "light", motion: "off" });

    await page.goto("/t/t-flaky");
    await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
    await expect(page.getByTestId("approval-card")).toBeVisible({ timeout: 20_000 });
    // By now the server's settings have loaded; they must not have replaced the seed.
    await expect(page.locator("html")).toHaveAttribute("data-palette", palette);
    await page.screenshot({ path: `e2e/__screenshots__/thread-${palette}.png` });
  });
}
