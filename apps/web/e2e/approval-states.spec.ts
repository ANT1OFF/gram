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

test("the card sits under the row it decides, and its key 1 answers it there", async ({ page }) => {
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
  // On screen and selected, it takes its key, measured when the key is pressed.
  expect(await card.evaluate((element) => element.closest("[hidden], [inert]"))).toBeNull();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("1");
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("approval-receipt")).toContainText("Allowed once");
});

test("answered with a click, focus goes on to the composer rather than the page", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const card = page.getByTestId("approval-card");
  await card.waitFor();
  await card.getByTestId("approval-allow").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
});

test("the card's amber outline is whole: no side of it is clipped by the message it sits in", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const card = page.getByTestId("approval-card");
  await card.waitFor();
  // The ring is drawn on the card's own edge. A pixel outside it, the message's content, which
  // clips what overhangs it, cut its left and right sides and left the top and bottom.
  const ring = page.getByTestId("approval-place").getByTestId("attention-ring");
  await expect(ring).toHaveCSS("box-shadow", /inset/);
  const clipped = await ring.evaluate((element) => {
    const box = element.getBoundingClientRect();
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (getComputedStyle(node).overflowX === "visible") continue;
      const clip = node.getBoundingClientRect();
      // Whether any clipping box around it is narrower than the ring.
      if (clip.left > box.left || clip.right < box.right) return true;
    }
    return false;
  });
  expect(clipped).toBe(false);
});
