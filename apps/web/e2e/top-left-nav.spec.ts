import { expect, test, type Page } from "@playwright/test";

// Usage and Settings at the window's top left in the Orchestrator layout: in the overview's header
// while it is shown, in the title bar while it is hidden, never both. Usage's dot marks a nearly
// used subscription window. Limits are the mock's invented readings, never a live account's.

const MOCK_SETTINGS_KEY = "gram.mock.settings";

const start = async (page: Page, flags: Record<string, string> = {}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(
    ([key, more]) => {
      if (sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(key, JSON.stringify({ panel: { open: false } }));
      }
      for (const [name, value] of Object.entries(more)) {
        if (sessionStorage.getItem(name) === null) sessionStorage.setItem(name, value);
      }
    },
    [MOCK_SETTINGS_KEY, flags] as const,
  );
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
};

const overview = (page: Page) => page.getByTestId("overview-sidebar");
const titlebar = (page: Page) => page.getByTestId("shell-titlebar");

test("Usage and Settings sit at the top left, in the overview or the title bar", async ({
  page,
}) => {
  await start(page);
  await expect(overview(page)).toBeVisible();
  await expect(page.getByTestId("top-left-nav")).toHaveCount(1);
  const nav = overview(page).getByTestId("top-left-nav");
  const hint = page.locator('[data-slot="tooltip-content"][data-open]');

  await nav.getByRole("button", { name: "Settings", exact: true }).hover();
  await expect(hint).toHaveText(/^Settings \(.+\)$/);
  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(nav.getByRole("button", { name: "Settings", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await nav.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page).toHaveURL(/\/usage$/);
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();

  // Hidden, the pair moves to the title bar's left, still one of each.
  await page.keyboard.press("ControlOrMeta+b");
  await expect(overview(page)).toHaveCount(0);
  await expect(page.getByTestId("top-left-nav")).toHaveCount(1);
  const moved = titlebar(page).getByTestId("top-left-nav");
  await expect(moved.getByRole("button", { name: "Usage", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await moved.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);

  await page.keyboard.press("ControlOrMeta+b");
  await expect(overview(page).getByTestId("top-left-nav")).toBeVisible();
  await expect(titlebar(page).getByTestId("top-left-nav")).toHaveCount(0);
});

test("Usage carries a dot only once a window is nearly used, and names it on hover", async ({
  page,
}) => {
  await start(page, { "gram.mock.limits": "none" });
  await page.waitForFunction(() => window.gramMock !== undefined);
  const usage = overview(page).getByRole("button", { name: "Usage", exact: true });
  const dot = page.getByTestId("top-left-usage-dot");
  const hint = page.locator('[data-slot="tooltip-content"][data-open]');
  await expect(usage).toBeVisible();
  await expect(dot).toHaveCount(0);
  await usage.hover();
  await expect(hint).toHaveText("Usage");
  await page.mouse.move(1000, 800);

  await page.evaluate(() =>
    window.gramMock!.simulateUsageLimit({
      agent: "claude",
      window: "five_hour",
      utilization: 0.42,
      resetsAt: Date.now() + 2 * 3_600_000,
    }),
  );
  await expect(page.getByTestId("usage-meter")).toHaveText("Claude 42%");
  await expect(dot).toHaveCount(0);
  await usage.hover();
  await expect(hint).toHaveText(/^Usage\s+Claude 42% of the 5-hour limit$/);
  await page.mouse.move(1000, 800);

  await page.evaluate(() =>
    window.gramMock!.simulateUsageLimit({
      agent: "claude",
      window: "five_hour",
      utilization: 0.86,
      resetsAt: Date.now() + 2 * 3_600_000,
    }),
  );
  await expect(dot).toBeVisible();
  await expect(usage).toHaveAttribute("data-warn", "true");
});
