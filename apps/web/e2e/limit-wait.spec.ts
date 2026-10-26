import { expect, test } from "@playwright/test";

const SHOTS = process.env["GRAM_LIMIT_WAIT_SHOTS"];

test("a thread at its usage limit waits on one quiet line, and resumes on request", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto("/t/t-docs");
  // Under 1280 px the overview is its compact rail, with no thread rows: the composer says the
  // thread has loaded.
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  const resumeAt = Date.now() + 110 * 60_000;
  // Before this change: the same limit ended the turn in a red error card, thread in `error`.
  await page.evaluate(() => {
    window.gramMock!.simulateTurnError(
      "t-docs" as never,
      {
        kind: "rateLimit",
        httpStatus: 429,
        retryable: true,
        text: "The provider is rate limiting requests (HTTP 429). Try again in a moment.",
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
  await expect(line).toContainText(/^Limit reached · resumes (?:[A-Z][a-z]{2} )?\d{2}:\d{2}/);
  await expect(page.getByTestId("agent-error")).toHaveCount(0);
  if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/after.png` });

  await line.getByRole("button", { name: "Resume now" }).click();
  await expect(line).toBeHidden();
});

const DAY_SHOTS = process.env["GRAM_LIMIT_DAY_SHOTS"];

test("a wait that resumes on another day names the day, as the meter does", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto("/t/t-release");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  const resumeAt = Date.now() + 3 * 24 * 60 * 60_000;
  await page.evaluate((at) => {
    window.gramMock!.simulateLimitWait(
      "t-release" as never,
      { kind: "limit", resetsAt: at - 20_000, resumeAt: at, attempt: 0 },
      "Carry on with the brief",
    );
  }, resumeAt);
  // Before: "resumes 21:00", read as tonight, for a resume three days off.
  await expect(page.getByTestId("limit-wait")).toContainText(
    /^Limit reached · resumes [A-Z][a-z]{2} \d{2}:\d{2}/,
  );
  if (DAY_SHOTS !== undefined) await page.screenshot({ path: `${DAY_SHOTS}/after.png` });
});

const CLEARED_SHOTS = process.env["GRAM_LIMIT_CLEARED_SHOTS"];

test("a wait whose limit no longer applies says it cleared, and resumes on its own", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto("/t/t-release");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  const resetAt = Date.now() + 3 * 60 * 60_000;
  await page.evaluate((at) => {
    window.gramMock!.simulateLimitWait(
      "t-release" as never,
      { kind: "limit", resetsAt: at - 20_000, resumeAt: at, attempt: 0 },
      "Carry on with the brief",
    );
  }, resetAt);
  const line = page.getByTestId("limit-wait");
  // Before: the stale wait stood until its reset, or until the user clicked Resume now.
  await expect(line).toContainText(/^Limit reached · resumes (?:[A-Z][a-z]{2} )?\d{2}:\d{2}/);
  if (CLEARED_SHOTS !== undefined) await page.screenshot({ path: `${CLEARED_SHOTS}/before.png` });

  // Fresh readings show the account well below its limit: the wait ends early, staggered.
  await page.evaluate(() => {
    void window.gramMock!.simulateLimitCleared("t-release" as never, Date.now() + 8_000);
  });
  await expect(line).toContainText(/^Limit cleared · resumes (?:[A-Z][a-z]{2} )?\d{2}:\d{2}/);
  await page.evaluate(() => {
    void window.gramMock!.simulateLimitCleared("t-release" as never);
  });
  await expect(line).toBeHidden();
  const cleared = page.getByTestId("limit-cleared");
  await expect(cleared).toContainText(/^Limit cleared · resumed \d{2}:\d{2}$/);
  if (CLEARED_SHOTS !== undefined) await page.screenshot({ path: `${CLEARED_SHOTS}/after.png` });
});

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
  await expect(meter).toContainText("Claude 100% · credits");
  await meter.click();
  await expect(page.getByTestId("usage-limit-credits")).toHaveText(
    "Past the limit on credits; turns go on",
  );
  // Let the popover finish opening before the picture.
  await page.waitForTimeout(400);
  if (CLEARED_SHOTS !== undefined) await page.screenshot({ path: `${CLEARED_SHOTS}/meter.png` });
});
