import { expect, test } from "@playwright/test";

import { openHeaderMore, openMore } from "./more-menu";
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
  await page.getByRole("menuitem", { name: "Park", exact: true }).click();
  // Parked, it leaves Solo threads for the folded Parked line under them.
  const parked = page.getByTestId("overview-parked");
  await expect(threadRow(page, "t-deps")).toBeHidden();
  await parked.getByRole("button", { name: /Parked/ }).click();
  await expect(parked).toContainText("Bump deps, carefully");
  await expect(threadRow(page, "t-deps")).toBeVisible();

  await page.getByRole("button", { name: "Thread menu" }).first().click();
  await page.getByRole("menuitem", { name: /Close thread/ }).click();
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
        text: "The gateway is rate limiting requests (HTTP 429). Try again in a moment.",
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
