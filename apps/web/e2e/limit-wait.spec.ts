import { expect, test } from "@playwright/test";

test.use({ timezoneId: "UTC" });
const SHOTS = process.env["GRAM_LIMIT_WAIT_SHOTS"];
const DAY_SHOTS = process.env["GRAM_LIMIT_DAY_SHOTS"];
const CLEARED_SHOTS = process.env["GRAM_LIMIT_CLEARED_SHOTS"];

// Fix both the browser's day and the synthetic resets; Node's wall clock is independent of
// page.clock. The midnight cases catch date prefixes on both the long wait and the 8 s stagger.
for (const clock of [
  {
    name: "midday",
    now: "2026-11-05T12:00:00Z",
    requested: "13:50",
    laterDay: "8 Nov 12:00",
    limited: "15:00",
    cleared: "12:00",
    resumed: "12:00",
  },
  {
    name: "just before midnight",
    now: "2026-11-05T23:59:55Z",
    requested: "6 Nov 01:49",
    laterDay: "8 Nov 23:59",
    limited: "6 Nov 02:59",
    cleared: "6 Nov 00:00",
    resumed: "23:59",
  },
  {
    name: "just after midnight",
    now: "2026-11-06T00:00:05Z",
    requested: "01:50",
    laterDay: "9 Nov 00:00",
    limited: "03:00",
    cleared: "00:00",
    resumed: "00:00",
  },
]) {
  test.describe(clock.name, () => {
    const now = Date.parse(clock.now);
    test.beforeEach(async ({ page }) => {
      // Keep timers running for UI interactions while Date.now() stays deterministic.
      await page.clock.setFixedTime(new Date(now));
    });

    test("a thread at its usage limit waits on one quiet line, and resumes on request", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1100, height: 760 });
      await page.goto("/t/t-docs");
      // Under 1280 px the overview is its compact rail, with no thread rows: the composer says the
      // thread has loaded.
      await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
      const resumeAt = now + 110 * 60_000;
      // Before this change: the same limit ended the turn in a red error card, thread in `error`.
      await page.evaluate(() => {
        window.gramMock!.simulateTurnError(
          "t-docs" as never,
          {
            kind: "rateLimit",
            httpStatus: 429,
            retryable: true,
            text: "The provider is rate limiting requests (HTTP 429).",
          },
          "Carry on with the brief",
        );
      });
      await expect(page.getByTestId("agent-error").last()).toBeVisible();
      if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/before.png` });

      await page.goto("/t/t-release");
      await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
      await page.evaluate((at) => {
        window.gramMock!.simulateLimitWait(
          "t-release" as never,
          { kind: "limit", resetsAt: at - 20_000, resumeAt: at, attempt: 0 },
          "Carry on with the brief",
        );
      }, resumeAt);
      const line = page.getByTestId("limit-wait");
      await expect(line.locator("span").first()).toHaveText(
        `Limit reached · resumes ${clock.requested}`,
      );
      await expect(page.getByTestId("agent-error")).toHaveCount(0);
      // The line follows the turn it holds, not the composer far below it.
      const asked = await page.getByTestId("message-user").last().boundingBox();
      const lineBox = await line.boundingBox();
      expect(lineBox!.y - (asked!.y + asked!.height)).toBeLessThan(120);
      if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/after.png` });

      await line.getByRole("button", { name: "Resume now" }).click();
      await expect(line).toBeHidden();
    });

    test("a wait that resumes on another day names the day, as the meter does", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1100, height: 760 });
      await page.goto("/t/t-release");
      await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
      const resumeAt = now + 3 * 24 * 60 * 60_000;
      await page.evaluate((at) => {
        window.gramMock!.simulateLimitWait(
          "t-release" as never,
          { kind: "limit", resetsAt: at - 20_000, resumeAt: at, attempt: 0 },
          "Carry on with the brief",
        );
      }, resumeAt);
      await expect(page.getByTestId("limit-wait").locator("span").first()).toHaveText(
        `Limit reached · resumes ${clock.laterDay}`,
      );
      if (DAY_SHOTS !== undefined) await page.screenshot({ path: `${DAY_SHOTS}/after.png` });
    });

    test("a wait whose limit no longer applies says it cleared, and resumes on its own", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1100, height: 760 });
      await page.goto("/t/t-release");
      await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
      const resetAt = now + 3 * 60 * 60_000;
      await page.evaluate((at) => {
        window.gramMock!.simulateLimitWait(
          "t-release" as never,
          { kind: "limit", resetsAt: at - 20_000, resumeAt: at, attempt: 0 },
          "Carry on with the brief",
        );
      }, resetAt);
      const line = page.getByTestId("limit-wait");
      // Before: the stale wait stood until its reset, or until the user clicked Resume now.
      await expect(line.locator("span").first()).toHaveText(
        `Limit reached · resumes ${clock.limited}`,
      );
      if (CLEARED_SHOTS !== undefined)
        await page.screenshot({ path: `${CLEARED_SHOTS}/before.png` });

      // Fresh readings show the account well below its limit: the wait ends early, staggered.
      await page.evaluate(() => {
        void window.gramMock!.simulateLimitCleared("t-release" as never, Date.now() + 8_000);
      });
      await expect(line.locator("span").first()).toHaveText(
        `Limit cleared · resumes ${clock.cleared}`,
      );
      await page.evaluate(() => {
        void window.gramMock!.simulateLimitCleared("t-release" as never);
      });
      await expect(line).toBeHidden();
      const cleared = page.getByTestId("limit-cleared");
      await expect(cleared).toHaveText(`Limit cleared · resumed ${clock.resumed}`);
      if (CLEARED_SHOTS !== undefined)
        await page.screenshot({ path: `${CLEARED_SHOTS}/after.png` });
    });
  });
}

test("a full window carried on credits reads as credits in the meter, not a stop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 760 });
  await page.goto("/t/t-release");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.gramMock!.simulateUsageLimit({
      agent: "claude",
      window: "five_hour",
      utilization: 1,
      resetsAt: Date.now() + 2 * 60 * 60_000,
      credits: true,
    });
  });
  const meter = page.getByTestId("usage-meter");
  await expect(meter).toContainText("Claude 100% used · credits");
  await meter.click();
  await expect(page.getByTestId("usage-limit-credits")).toHaveText(
    "Past the limit on credits; turns go on",
  );
  // Let the popover finish opening before the picture.
  await page.waitForTimeout(400);
  if (CLEARED_SHOTS !== undefined) await page.screenshot({ path: `${CLEARED_SHOTS}/meter.png` });
});
