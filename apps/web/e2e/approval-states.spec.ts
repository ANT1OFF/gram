import { expect, test } from "@playwright/test";

// A tool call held at an approval card waits, rather than runs, until the user answers; the card's
// "Always allow…" shows the exact rule and where it is kept before anything is saved. Synthetic
// mock state (the scripted `t-flaky` thread); nothing reaches a provider.

test("a call held at its approval waits, then runs and finishes once allowed", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const card = page.getByTestId("approval-card");
  await card.waitFor();
  const row = page.locator('[data-testid="tool-card"][data-tool="Bash"]').last();
  await expect(row).toContainText("Waiting for your approval");
  await expect(row).not.toContainText("Running");

  // The buttons say what they do; "Always allow…" saves nothing on its first press.
  await expect(card.getByTestId("approval-allow")).toContainText("Allow once");
  await card.getByTestId("approval-always").click();
  const rule = card.getByTestId("approval-always-rule");
  await expect(rule).toContainText("Bash(git push origin fix/flaky-retry)");
  await expect(rule).toHaveAttribute("data-reach", "folder");
  await expect(rule).toContainText(".claude/settings.local.json");
  await card.getByTestId("approval-always-back").click();
  await expect(rule).toHaveCount(0);

  await card.getByTestId("approval-allow").click();
  await expect(card).toHaveCount(0);
  await expect(row).not.toContainText("Waiting for your approval");
  // Its outcome: the check that marks it done, the push's output in its details.
  await expect(row.locator('[title="Done"]')).toBeVisible({ timeout: 15_000 });
});
