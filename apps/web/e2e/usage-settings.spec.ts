import { expect, test, type Page } from "@playwright/test";

// Settings → Usage: each subscription's windows with their pace, Codex's credits and their burn,
// and the limit history over a week or a month. Everything is the mock's invented readings and
// history (`api/mock-limits.ts`, `api/mock-limit-history.ts`), on a pinned clock; never a live
// account's.

test.use({ timezoneId: "UTC" });

/** Pinned: a Tuesday morning, so the history's waking hours and day labels read the same. */
const NOW = new Date("2026-11-03T09:00:00Z");

const seed = (page: Page, flags: Record<string, string>) =>
  page.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) {
      if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, value);
    }
  }, flags);

test("the meter's Open Usage opens Settings → Usage, with pace, credits and history", async ({
  page,
}) => {
  await page.clock.setFixedTime(NOW);
  await page.goto("/t/t-flaky");
  await page.getByTestId("usage-meter").click();
  await page.getByTestId("usage-limits-page").click();
  await expect(page).toHaveURL(/\/settings\/usage$/);
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  const usage = page.getByTestId("usage-settings");

  // Both subscriptions, each with its 5-hour and weekly windows.
  await expect(usage.getByTestId("usage-provider")).toHaveCount(2);
  const codex = usage.getByRole("region", { name: "Codex" });
  const fiveHour = codex.getByRole("group", { name: "Codex 5-hour limit" });
  await expect(fiveHour.getByTestId("usage-window-percent")).toHaveText("85%");
  await expect(fiveHour.getByTestId("usage-window-reset")).toHaveText(/^Resets \d{2}:\d{2}$/);
  // Three quarters of the window gone and 85% used: ahead of an even pace, marked on the bar.
  await expect(fiveHour.getByTestId("usage-window-pace")).toHaveText(
    /^\d+ pts ahead of pace · \d+% of the window gone$/,
  );
  await expect(fiveHour.getByTestId("usage-window-even")).toBeVisible();
  await expect(fiveHour.getByTestId("usage-window-forecast")).toHaveText(
    /^Estimate at recent pace: 90% around \d{2}:\d{2}$/,
  );
  const claudeWeek = usage
    .getByRole("region", { name: "Claude Code" })
    .getByRole("group", { name: "Claude Code weekly limit" });
  await expect(claudeWeek.getByTestId("usage-window-percent")).toHaveText("61%");
  await expect(claudeWeek.getByTestId("usage-window-reset")).toHaveText(
    /^Resets \d+ [A-Z][a-z]{2} \d{2}:\d{2}$/,
  );

  // Codex's credits: the balance its readings name, and what the kept balances say it burns.
  const credits = codex.getByRole("group", { name: "Codex credits" });
  await expect(credits.getByTestId("usage-credits-balance")).toHaveText("1,250left");
  await expect(credits.getByTestId("usage-credits-burn")).toHaveText(
    /^[\d,]+ spent over 7 days · about [\d,]+ a day$/,
  );
  await expect(credits.getByTestId("usage-credits-history")).toBeVisible();
  // Claude reports no credits, so it has no credits card.
  await expect(usage.getByTestId("usage-credits")).toHaveCount(1);

  // Every window has a week of history, a line under the 90% mark, and its peak.
  await expect(usage.getByTestId("usage-window-history")).toHaveCount(4);
  await expect(fiveHour.getByTestId("usage-history-guide")).toHaveCount(1);
  await expect(fiveHour.getByTestId("usage-window-summary")).toHaveText(/^Peak \d+%/);

  // Hovering the chart reads the bucket under the pointer.
  const chart = fiveHour.getByTestId("usage-window-history");
  await chart.scrollIntoViewIfNeeded();
  const box = (await chart.boundingBox())!;
  // Near the right edge of the plot, past the axis column: the latest readings.
  await chart.hover({ position: { x: box.width - 8, y: 30 } });
  await expect(fiveHour.getByTestId("usage-history-hover")).toHaveText(/\d+%$/);

  // A month: the same windows, by the hour, with the burn over the longer span.
  await page
    .getByRole("radiogroup", { name: "History period" })
    .getByRole("radio", {
      name: "30 days",
    })
    .click();
  await expect(credits.getByTestId("usage-credits-burn")).toHaveText(
    /^[\d,]+ spent over 30 days · about [\d,]+ a day · 500 added$/,
  );
  await expect(usage.getByTestId("usage-window-history")).toHaveCount(4);

  // Limits are per account; the tokens by workspace and thread are a link away.
  await usage.getByTestId("usage-settings-tokens").click();
  await expect(page).toHaveURL(/\/usage$/);
  await expect(page.getByTestId("usage-limits-history-link")).toBeVisible();
});

test("with nothing reported, the page says where limits come from", async ({ page }) => {
  await seed(page, { "gram.mock.limits": "none" });
  await page.clock.setFixedTime(NOW);
  await page.goto("/settings/usage");
  await expect(page.getByTestId("usage-settings-none")).toBeVisible();
  await expect(page.getByTestId("usage-provider")).toHaveCount(0);
  // Settings lists it, and its search finds it by what it holds.
  await expect(page.getByRole("link", { name: "Usage", exact: true })).toBeVisible();
});
