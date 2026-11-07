import { expect, test, type Page } from "@playwright/test";

import { flakyAsked } from "./seed-asks";

// The title bar's subscription meter, and a launch that lands on the orchestrator. The limits are
// the mock's invented readings (`api/mock-limits.ts`), never a live account's.

const seed = (page: Page, flags: Record<string, string>) =>
  page.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) sessionStorage.setItem(key, value);
  }, flags);

const WELCOME_UNSEEN = JSON.stringify({ onboarding: { welcomeSeen: false } });

const RESETS = /^(\d{1,2} [A-Z][a-z]{2}( \d{4})? )?\d{2}:\d{2}$/;

test("the meter shows the thread's agent's limit and opens onto both providers", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const meter = page.getByTestId("usage-meter");
  // A Claude thread shows Claude's closest window (weekly, 61%), not Codex's higher 85%: the meter
  // names the agent the composer names. Short of the warning, the title bar's only amber stays
  // what needs you.
  await expect(meter).toHaveText("Claude 61% used");
  await expect(meter).not.toHaveAttribute("data-warn");
  await expect(meter).toHaveAccessibleName(
    "This thread's agent's subscription usage: Claude Code weekly limit 61% used",
  );
  // Open, the popover gives way to the approval card: let the thread's opening turn raise it.
  await flakyAsked(page);

  await meter.click();
  const popover = page.getByRole("dialog", { name: "Subscription usage" });
  await expect(popover).toBeVisible();
  // The columns are named once, so the rows line up under them without repeating the words.
  await expect(popover.getByTestId("usage-limits-columns")).toHaveText(/^\s*Used\s*Resets\s*$/);
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
      // Each row says its period, the share used and when it resets, under the columns' names,
      // and all three in words in its name.
      await expect(cells.nth(0)).toHaveText(label);
      await expect(cells.nth(1)).toHaveText(rows[i]!);
      await expect(windows.nth(i)).toHaveAccessibleName(
        new RegExp(`^${label}: ${rows[i]!} used, resets `),
      );
      // Resets on a 24-hour clock: today's as a time, later ones with their date before it.
      await expect(cells.nth(2)).toHaveText(RESETS);
    }
  }
  await expect(popover).toContainText("Includes your own use outside Gram.");
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // Open, it gives way once focus moves to the conversation (an approval card's buttons, the
  // composer), so it never sits over the card that asks.
  await meter.click();
  await expect(popover).toBeVisible();
  await page.getByLabel("Message", { exact: true }).focus();
  await expect(popover).toBeHidden();
  await meter.click();
  await expect(popover).toBeVisible();
  await page
    .getByRole("button", { name: /^Allow once/ })
    .first()
    .focus();
  await expect(popover).toBeHidden();
});

test("the meter waits for a limit, warns from 90% once, and ignores gateways", async ({ page }) => {
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
  await expect(meter).toHaveText("Claude 50% used");
  await expect(meter).not.toHaveAttribute("data-warn");
  const fill = meter.getByTestId("usage-meter-fill");
  await expect(fill).toHaveAttribute("style", /width: 50%/);
  await expect(page.getByTestId("pulse-once")).toHaveCount(0);

  // 85% is close, not yet a warning: the meter stays neutral.
  await report(0.85);
  await expect(meter).toHaveText("Claude 85% used");
  await expect(meter).not.toHaveAttribute("data-warn");
  await expect(page.getByTestId("pulse-once")).toHaveCount(0);

  // Crossing 90% turns it warning-coloured, with one pulse.
  await report(0.92, { status: "warning" });
  await expect(meter).toHaveText("Claude 92% used");
  await expect(meter).toHaveAttribute("data-warn", "true");
  await expect(fill).toHaveAttribute("style", /width: 92%/);
  await expect(page.getByTestId("pulse-once")).toHaveCount(1);

  // A gateway's limit is its own quota, not the subscription's.
  await report(0.99, { gateway: true });
  await expect(meter).toHaveText("Claude 92% used");

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
    // The workspace is listed, so a landing on its orchestrator could have happened. Settings has
    // no overview to show it in, so there the app's own list is asked.
    if (link.startsWith("/settings")) {
      await expect(page.getByTestId("settings-title")).toBeVisible();
      await expect
        .poll(() => page.evaluate(async () => (await window.gramMock!.listWorkspaces()).length))
        .toBeGreaterThan(0);
    } else {
      await expect(page.getByTestId("overview-workspace").first()).toBeVisible();
    }
    // Long enough for a landing to have happened; it never does off the home page.
    await page.waitForTimeout(1_000);
    await expect(page).toHaveURL(new RegExp(`${link}$`));
  });
}
