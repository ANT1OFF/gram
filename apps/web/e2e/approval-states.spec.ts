import { expect, test } from "@playwright/test";

// A tool call held at an approval card waits, rather than runs, until the user answers; the card's
// "Always allow this rule…" shows the exact rule and where it is kept before anything is saved. Synthetic
// mock state (the scripted `t-flaky` thread); nothing reaches a provider.

test("a call held at its approval waits, then runs and finishes once allowed", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const card = page.getByTestId("approval-card");
  await card.waitFor();
  const row = page.locator('[data-testid="tool-card"][data-tool="Bash"]').last();
  await expect(row).toContainText("Waiting for your approval");
  await expect(row).not.toContainText("Running");

  // The buttons say what they do; "Always allow this rule…" saves nothing on its first press.
  await expect(card.getByTestId("approval-allow")).toContainText("Allow once");
  await card.getByTestId("approval-always").click();
  const rule = card.getByTestId("approval-always-rule");
  await expect(rule).toContainText("Bash(git push origin fix/flaky-retry)");
  await expect(rule).toHaveAttribute("data-reach", "repository");
  await expect(rule).toContainText("all its worktrees");
  await expect(rule).toContainText(".claude/settings.local.json at the repository root");
  await card.getByTestId("approval-always-back").click();
  await expect(rule).toHaveCount(0);

  await card.getByTestId("approval-allow").click();
  await expect(card).toHaveCount(0);
  // Allowed, it runs and settles; the finished turn may fold it away, so open the fold to read it.
  const transcript = page.getByTestId("transcript");
  await expect(transcript).not.toContainText("Waiting for your approval");
  const fold = page.getByTestId("turn-fold").last();
  await expect(fold).toHaveAttribute("data-state", /worked|failed|stopped/, { timeout: 15_000 });
  if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
  const done = page.locator('[data-testid="tool-card"][data-tool="Bash"]').filter({
    hasText: "git push origin fix/flaky-retry",
  });
  await expect(done.last().locator('[title="Done"]')).toBeVisible();
});

test("the card sits under the row it decides, and Enter answers it there", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const card = page.getByTestId("approval-card");
  await card.waitFor();
  // Drawn in the transcript, right under the waiting row, with no link down to it.
  const slot = page.getByTestId("transcript").getByTestId("approval-slot");
  await expect(slot).toHaveCount(1);
  await expect(slot.getByTestId("approval-card")).toBeVisible();
  await expect(page.getByTestId("approval-place")).toHaveAttribute("data-inline", "true");
  await expect(page.getByTestId("approval-link")).toHaveCount(0);
  const row = page.locator('[data-testid="tool-card"][data-tool="Bash"]').last();
  const [rowBox, cardBox] = [await row.boundingBox(), await card.boundingBox()];
  expect(cardBox!.y - (rowBox!.y + rowBox!.height)).toBeLessThan(16);
  // On screen and selected, it takes Enter, measured when the key is pressed.
  expect(await card.evaluate((element) => element.closest("[hidden], [inert]"))).toBeNull();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Enter");
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("approval-receipt")).toContainText("Allowed once");
});
