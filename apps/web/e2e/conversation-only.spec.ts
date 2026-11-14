import { expect, test } from "@playwright/test";

import { threadRow } from "./thread-row";

// "Conversation only": the header's switch takes every tool call and fold row out of the
// transcript and leaves the words, and stays on across a reload.

test("the header's switch hides the agent's tool calls and brings them back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const transcript = page.locator('[data-thread-view="t-flaky"]');
  const work = transcript.locator(
    '[data-testid="tool-group"], [data-testid="tool-card"], [data-testid="turn-fold"]',
  );
  await expect(work.first()).toBeVisible();
  const words = await transcript.getByTestId("message-assistant").count();
  expect(words).toBeGreaterThan(0);

  // Alone in the window the thread's header is in the title bar, outside its view.
  const toggle = page.getByTestId("conversation-only");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(page.getByTestId("conversation-only")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("conversation-only")).toHaveText("Conversation only");
  await expect(work).toHaveCount(0);
  await expect(transcript.getByTestId("message-user").first()).toBeVisible();

  // Kept across a reload: it is the reader's choice for every thread, not this visit's.
  await page.reload();
  await expect(page.getByTestId("conversation-only")).toHaveAttribute("aria-pressed", "true");
  await expect(work).toHaveCount(0);

  await page.getByTestId("conversation-only").click();
  await expect(work.first()).toBeVisible();
});
