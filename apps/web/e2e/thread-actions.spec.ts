import { expect, test } from "@playwright/test";

import { openHeaderMore, openMore, openThreadMenu } from "./more-menu";
import { threadRow } from "./thread-row";

test("renames and parks from the row menu, and closes with the worktree checklist", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");

  await threadRow(page, "t-deps").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Rename/ }).click();
  const rename = page.getByTestId("rename-dialog");
  await rename.getByLabel("Thread title").fill("Bump deps, carefully");
  await rename.getByRole("button", { name: "Rename" }).click();
  await expect(threadRow(page, "t-deps")).toContainText("Bump deps, carefully");

  await threadRow(page, "t-deps").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  // Parked, it leaves Solo threads for the folded Parked line under them.
  const parked = page.getByTestId("overview-parked");
  await expect(threadRow(page, "t-deps")).toBeHidden();
  await parked.getByRole("button", { name: /Archived/ }).click();
  await expect(parked).toContainText("Bump deps, carefully");
  await expect(threadRow(page, "t-deps")).toBeVisible();

  await (await openThreadMenu(page)).getByRole("menuitem", { name: /Close thread/ }).click();
  const close = page.getByTestId("close-thread-dialog");
  await expect(close).toContainText("5 uncommitted changes");
  await close.getByRole("checkbox", { name: /Also delete the worktree/ }).check();
  await expect(close).toContainText("Bash(pnpm test:*)");
  await close.getByRole("button", { name: "Close and delete worktree" }).click();
  await expect(close).toContainText("Delete it anyway?");
  await close.getByRole("button", { name: "Delete anyway" }).click();
  await expect(close).toBeHidden();
  await expect(threadRow(page, "t-flaky")).toHaveCount(0);
});

test("a link to a thread that no longer exists says so, and closes back home", async ({ page }) => {
  await page.goto("/t/t-no-such-thread");
  const gone = page.getByTestId("thread-gone");
  await expect(gone).toContainText("This thread no longer exists.");
  await expect(page.getByTestId("connection-banner")).toBeHidden();
  await gone.getByRole("button", { name: "Close" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("a retry that fails says so on the failed turn's card", async ({ page }) => {
  await page.goto("/t/t-docs");
  await expect(threadRow(page, "t-docs")).toBeVisible();
  await page.evaluate(() => {
    const mock = window.gramMock!;
    mock.simulateTurnError(
      "t-docs" as never,
      {
        kind: "rateLimit",
        httpStatus: 429,
        retryable: true,
        text: "The provider is rate limiting requests (HTTP 429).",
      },
      "Run the e2e suite",
    );
    mock.send = async () => {
      throw new Error("The connection to Gram dropped");
    };
  });
  const card = page.getByTestId("agent-error").last();
  await card.getByRole("button", { name: "Retry" }).click();
  await expect(card.getByTestId("retry-unsent")).toHaveText(
    "Couldn't confirm the retry reached the agent: The connection to Gram dropped. Check the transcript before trying again.",
  );
  await expect(card.getByRole("button", { name: "Retry" })).toBeEnabled();
});

test("restarts a session at rest from the row's More…, and marks the transcript", async ({
  page,
}) => {
  await page.goto("/t/t-release");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("Is rc5 ready to soak?");
  await composer.press("Enter");
  await expect(page.getByTestId("message-user")).toContainText("Is rc5 ready to soak?");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();

  const more = await openMore(page, threadRow(page, "t-release"));
  await more.getByRole("option", { name: "Restart session" }).click();
  await expect(page.getByTestId("restart-session-dialog")).toHaveCount(0);
  await expect(page.getByTestId("session-restart")).toHaveText(
    /^Session restarted · config reloaded · \d\d:\d\d/,
  );
});

test("asks before a restart that would cut a turn off, then waits for it or interrupts it", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  await page.goto("/t/t-flaky");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  const markers = page.getByTestId("session-restart");

  const more = await openHeaderMore(page);
  await more.getByRole("option", { name: "Restart session" }).click();
  const dialog = page.getByTestId("restart-session-dialog");
  await expect(dialog).toContainText("A turn is running");
  await dialog.getByRole("button", { name: "Restart when this turn ends" }).click();
  await expect(
    page.getByTestId("toast").filter({ hasText: "Restarts when this turn ends" }),
  ).toBeVisible();
  await expect(markers).toHaveCount(0);
  await page.evaluate(() => window.gramMock?.release("flaky-read"));
  // The turn goes on to ask before a push, which is still the turn: the restart waits past it.
  const approval = page.getByTestId("approval-card");
  await approval.getByTestId("approval-allow").click({ timeout: 20_000 });
  await expect(markers).toHaveCount(1, { timeout: 30_000 });

  // The palette's action, against a turn held running again.
  await page.reload();
  await expect(stop).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill(">Restart session");
  await palette.getByText("Restart session", { exact: true }).click();
  await dialog.getByRole("button", { name: "Interrupt and restart" }).click();
  // The mock's turn sees the interrupt at its next step, past the gate.
  await page.evaluate(() => window.gramMock?.release("flaky-read"));
  await expect(stop).toBeHidden();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  await expect(markers).toHaveCount(1);
});

test("Stop leaves a receipt at the turn's end, and Continue picks the turn up", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  await page.goto("/t/t-flaky");
  await page.getByText("I'll start by reading the test").waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  const receipt = page.getByTestId("stop-receipt");
  await expect(receipt.getByTestId("stop-receipt-label")).toHaveText(
    /^Stopped by you · \d\d:\d\d$/,
  );
  // The reply it stopped on stays above it, the receipt right under it, not by the composer.
  const said = page.getByText("I'll start by reading the test");
  await expect(said).toBeVisible();
  const saidBox = await said.boundingBox();
  const receiptBox = await receipt.boundingBox();
  expect(receiptBox!.y - (saidBox!.y + saidBox!.height)).toBeLessThan(80);
  await receipt.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("message-user").last()).toContainText("Continue");
  await expect(receipt).toHaveCount(0);
});

test("a retry that went through turns the failed card into a quiet receipt, said once", async ({
  page,
}) => {
  await page.goto("/t/t-docs");
  await page.getByLabel("Message", { exact: true }).waitFor();
  await page.evaluate(() =>
    window.gramMock!.simulateTurnError(
      "t-docs" as never,
      { kind: "rateLimit", retryable: true, text: "Rate limited (HTTP 429)." },
      "Run the e2e suite",
    ),
  );
  const card = page.getByTestId("agent-error").last();
  await card.getByRole("button", { name: "Retry" }).click();
  await expect(card).toHaveAttribute("data-state", "retried");
  await expect(card.getByRole("button", { name: "Retry" })).toHaveCount(0);
  // Once the retry ran through, the receipt says what was done and how it went; the failure it
  // got past is folded under Details.
  await expect(card).toHaveAttribute("data-recovered", "true");
  await expect(card.getByTestId("agent-error-retried")).toHaveText(
    /^Retried at \d\d:\d\d · succeeded$/,
  );
  await expect(card.getByTestId("agent-error-history")).toBeHidden();
  await card.getByRole("button", { name: "Details" }).click();
  await expect(card.getByTestId("agent-error-history")).toContainText("Rate limited (HTTP 429).");
  // The retry's own words aren't said a second time: the receipt stands for them.
  await expect(
    page.getByTestId("message-user").filter({ hasText: "Run the e2e suite" }),
  ).toHaveCount(1);
});

test("a retry that failed too is one card: the newest attempt, with the earlier one folded", async ({
  page,
}) => {
  await page.goto("/t/t-docs");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const rateLimit = { kind: "rateLimit", retryable: true, text: "Rate limited (HTTP 429)." };
  await page.evaluate(
    (error) =>
      window.gramMock!.simulateTurnError("t-docs" as never, error as never, "Run the e2e suite"),
    rateLimit,
  );
  await expect(page.getByTestId("agent-error")).toHaveCount(1);
  await page.evaluate(
    (error) =>
      window.gramMock!.simulateTurnError("t-docs" as never, error as never, "Run the e2e suite"),
    rateLimit,
  );
  const card = page.getByTestId("agent-error");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-state", "failed");
  await expect(card.getByTestId("agent-error-attempt-number")).toHaveText(
    " · attempt 2 of 2 · needs action",
  );
  await expect(
    page.getByTestId("message-user").filter({ hasText: "Run the e2e suite" }),
  ).toHaveCount(1);
  await card.getByRole("button", { name: "1 earlier attempt" }).click();
  await expect(card.getByTestId("agent-error-earlier-attempt")).toContainText("Attempt 1");
});

test("a repeated rate limit offers an automatic retry in 30 s, and another model", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-11-05T12:00:00Z") });
  await page.goto("/t/t-docs");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const throttled = {
    kind: "rateLimit",
    httpStatus: 429,
    retryable: true,
    text: "The provider is rate limiting requests (HTTP 429).",
  } as const;
  for (let i = 0; i < 2; i++) {
    await page.evaluate(
      (error) => window.gramMock!.simulateTurnError("t-docs" as never, error, "Run the e2e suite"),
      throttled,
    );
  }
  const card = page.getByTestId("agent-error").last();
  await expect(card.getByTestId("agent-error-attempt-number")).toContainText("attempt 2 of 2");
  // Try another model opens this thread's model picker.
  await card.getByRole("button", { name: "Try another model" }).click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();

  await card.getByRole("button", { name: "Retry automatically in 30 s" }).click();
  const armed = card.getByTestId("agent-error-auto-retry-armed");
  // Never more than the 30 s it was set for, then counting down.
  await expect(armed).toContainText(/Retrying in (30|2\d) s/);
  await page.clock.runFor(10_000);
  await expect(armed).toContainText(/Retrying in (20|1\d) s/);
  // Cancel stands it down: Retry by hand is still there.
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByTestId("agent-error-auto-retry")).toBeVisible();
  // Armed again, it sends the turn's message once the time is up, as Retry does.
  await card.getByRole("button", { name: "Retry automatically in 30 s" }).click();
  await page.clock.runFor(31_000);
  await expect(card).toHaveAttribute("data-state", "retried");
});
