import { expect, test, type Page } from "@playwright/test";

// The title bar's subscription meter, and a launch that lands on the orchestrator. The limits are
// the mock's invented readings (`api/mock-limits.ts`), never a live account's.

const seed = (page: Page, flags: Record<string, string>) =>
  page.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) sessionStorage.setItem(key, value);
  }, flags);

const WELCOME_UNSEEN = JSON.stringify({ onboarding: { welcomeSeen: false } });

const CLOCK = /^(\d{2}:\d{2}|[A-Z][a-z]{2} \d{2}:\d{2})$/;

test("the meter shows the tightest limit and opens onto both providers", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const meter = page.getByTestId("usage-meter");
  // Codex's 5-hour window is at 85%, past the warning.
  await expect(meter).toHaveText("Codex 85%");
  await expect(meter).toHaveAttribute("data-warn", "true");
  await expect(meter).toHaveAccessibleName("Subscription usage: Codex 5-hour limit 85% used");

  await meter.click();
  const popover = page.getByRole("dialog", { name: "Subscription usage" });
  await expect(popover).toBeVisible();
  for (const [provider, rows] of [
    ["Claude Code", ["42%", "61%"]],
    ["Codex", ["85%", "30%"]],
  ] as const) {
    const section = popover.getByRole("region", { name: provider });
    await expect(section.getByRole("heading")).toHaveText(provider);
    const windows = section.getByTestId("usage-limit-row");
    await expect(windows).toHaveCount(2);
    for (const [i, label] of ["5-hour", "Weekly"].entries()) {
      const cells = windows.nth(i).locator(":scope > span:not([aria-hidden])");
      await expect(cells.nth(0)).toHaveText(label);
      await expect(cells.nth(1)).toHaveText(rows[i]!);
      // Resets on a 24-hour clock: today's as a time, later ones with their weekday.
      await expect(cells.nth(2)).toHaveText(CLOCK);
    }
  }
  await expect(popover).toContainText("Includes your own use outside Gram.");
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
});

test("the meter waits for a limit, warns from 80% once, and ignores gateways", async ({ page }) => {
  await seed(page, { "gram.mock.limits": "none" });
  await page.goto("/t/t-flaky");
  await expect(page.getByTestId("shell-titlebar")).toBeVisible();
  const meter = page.getByTestId("usage-meter");
  await expect(meter).toHaveCount(0);

  const report = (utilization: number, extra: Record<string, unknown> = {}) =>
    page.evaluate(
      (input) =>
        window.gramMock!.simulateUsageLimit({
          agent: "claude",
          window: "five_hour",
          resetsAt: Date.now() + 2 * 3_600_000,
          ...input,
        }),
      { utilization, ...extra },
    );

  await report(0.5);
  await expect(meter).toHaveText("Claude 50%");
  await expect(meter).not.toHaveAttribute("data-warn");
  const fill = meter.getByTestId("usage-meter-fill");
  await expect(fill).toHaveAttribute("style", /width: 50%/);
  await expect(page.getByTestId("pulse-once")).toHaveCount(0);

  // Crossing 80% turns it warning-coloured, with one pulse.
  await report(0.82, { status: "warning" });
  await expect(meter).toHaveText("Claude 82%");
  await expect(meter).toHaveAttribute("data-warn", "true");
  await expect(fill).toHaveAttribute("style", /width: 82%/);
  await expect(page.getByTestId("pulse-once")).toHaveCount(1);

  // A gateway's limit is its own quota, not the subscription's.
  await report(0.99, { gateway: true });
  await expect(meter).toHaveText("Claude 82%");

  // Codex hasn't reported, so the popover has Claude alone.
  await meter.click();
  const popover = page.getByRole("dialog", { name: "Subscription usage" });
  await expect(popover.getByRole("region", { name: "Claude Code" })).toBeVisible();
  await expect(popover.getByRole("region", { name: "Codex" })).toHaveCount(0);
});

test("a launch with a workspace lands on its orchestrator, without the welcome", async ({
  page,
}) => {
  await seed(page, {
    "gram.mock.settings": WELCOME_UNSEEN,
    "gram.mock.orchestration": "board",
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/t\/t-mock-\d+$/);
  const orchestrator = await page.evaluate(
    async () => (await window.gramMock!.listWorkspaces())[0]!.workspace.orchestratorThreadId,
  );
  expect(orchestrator).toBeDefined();
  await expect(page).toHaveURL(new RegExp(`/t/${orchestrator}$`));
  await expect(page.getByTestId("welcome")).toHaveCount(0);
});

test("a launch with no workspace stays home with the welcome", async ({ page }) => {
  await seed(page, { "gram.mock.settings": WELCOME_UNSEEN });
  await page.goto("/");
  await expect(page.getByTestId("welcome")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  // A workspace made after that launch takes the welcome away and leaves the page where it is.
  await page.evaluate(() => window.gramMock!.simulateOrchestration("board"));
  // The overview lists the new workspace.
  await expect(page.getByTestId("overview-workspace").first()).toBeVisible();
  await expect(page.getByTestId("welcome")).toHaveCount(0);
  await expect(page.getByText("Select a thread, or start a new one.")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

for (const link of ["/t/t-flaky", "/settings/general"]) {
  test(`a launch on ${link} stays there, though a workspace exists`, async ({ page }) => {
    await seed(page, {
      "gram.mock.settings": WELCOME_UNSEEN,
      "gram.mock.orchestration": "board",
    });
    await page.goto(link);
    // The overview lists the workspace, so a landing on its orchestrator could have happened.
    await expect(page.getByTestId("overview-workspace").first()).toBeVisible();
    // Long enough for a landing to have happened; it never does off the home page.
    await page.waitForTimeout(1_000);
    await expect(page).toHaveURL(new RegExp(`${link}$`));
  });
}
