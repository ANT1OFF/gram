import { expect, test, type Page } from "@playwright/test";

// Settings at the window's top left in the Orchestrator layout: in the overview's header while it is
// shown, in the title bar while it is hidden, never both. Usage has one way in, the title bar's
// meter: an icon until an agent reports a limit. Limits are the mock's invented readings, never a
// live account's.

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

test("Settings sits at the top left, in the overview or the title bar", async ({ page }) => {
  await start(page);
  await expect(overview(page)).toBeVisible();
  await expect(page.getByTestId("top-left-nav")).toHaveCount(1);
  const nav = overview(page).getByTestId("top-left-nav");
  const hint = page.locator('[data-slot="tooltip-content"][data-open]');
  await expect(nav.getByRole("button", { name: "Usage", exact: true })).toHaveCount(0);
  await expect(titlebar(page).getByTestId("inbox-button")).toHaveCount(0);

  await nav.getByRole("button", { name: "Settings", exact: true }).hover();
  await expect(hint).toHaveText(/^Settings \(.+\)$/);
  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  // Settings is a place of its own: the overview steps aside, the nav with it, and the title bar
  // has Back and the page's name in place of the workspace and its views. The needs-you pill keeps
  // its place, top left, over Settings' sections: the title bar has no Inbox beside it.
  await expect(titlebar(page).getByTestId("settings-title")).toHaveText("Settings");
  await expect(titlebar(page).getByTestId("workspace-switcher-button")).toHaveCount(0);
  await expect(titlebar(page).getByTestId("view-switcher")).toHaveCount(0);
  await expect(page.getByTestId("top-left-nav")).toHaveCount(0);
  const pill = page
    .getByRole("navigation", { name: "Settings sections" })
    .getByTestId("settings-needs-you");
  await expect(pill).toBeVisible();
  const pillBox = (await pill.boundingBox())!;
  expect(pillBox.x).toBeLessThan(40);
  await expect(titlebar(page).getByTestId("inbox-button")).toHaveCount(0);
  await page.getByTestId("settings-back").click();
  await expect(page).not.toHaveURL(/\/settings/);

  // Hidden, it moves to the title bar's left, still one.
  await page.keyboard.press("ControlOrMeta+b");
  await expect(overview(page)).toHaveCount(0);
  await expect(page.getByTestId("top-left-nav")).toHaveCount(1);
  const moved = titlebar(page).getByTestId("top-left-nav");
  await moved.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await page.getByTestId("settings-back").click();
  await expect(page).toHaveURL(/\/t\/t-flaky$/);

  await page.keyboard.press("ControlOrMeta+b");
  await expect(overview(page).getByTestId("top-left-nav")).toBeVisible();
  await expect(titlebar(page).getByTestId("top-left-nav")).toHaveCount(0);
});

test("usage has one way in: an icon before any reading, then the meter, which warns", async ({
  page,
}) => {
  await start(page, { "gram.mock.limits": "none" });
  await page.waitForFunction(() => window.gramMock !== undefined);
  const hint = page.locator('[data-slot="tooltip-content"][data-open]');
  const link = titlebar(page).getByTestId("usage-link");
  await expect(link).toBeVisible();
  await expect(page.getByRole("button", { name: "Usage", exact: true })).toHaveCount(1);
  await link.hover();
  await expect(hint).toHaveText("Usage");
  const box = (await link.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(28);
  expect(box.height).toBeGreaterThanOrEqual(28);
  await link.click();
  await expect(page).toHaveURL(/\/usage$/);
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await page.goBack();
  await page.mouse.move(1000, 800);

  await page.evaluate(() =>
    window.gramMock!.simulateUsageLimit({
      agent: "claude",
      window: "five_hour",
      utilization: 0.86,
      resetsAt: Date.now() + 2 * 3_600_000,
    }),
  );
  // A reading in: the meter takes the icon's place, short of the warning.
  const meter = page.getByTestId("usage-meter");
  await expect(meter).toHaveText("Claude 86% used");
  await expect(link).toHaveCount(0);
  await expect(meter).not.toHaveAttribute("data-warn");
  expect((await meter.boundingBox())!.height).toBeGreaterThanOrEqual(28);

  await page.evaluate(() =>
    window.gramMock!.simulateUsageLimit({
      agent: "claude",
      window: "five_hour",
      utilization: 0.93,
      resetsAt: Date.now() + 2 * 3_600_000,
    }),
  );
  await expect(meter).toHaveAttribute("data-warn", "true");
});
