import { expect, test } from "@playwright/test";

import { clipboardText as clipboard } from "./clipboard";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("copies a message and a turn as Markdown, by button and with ⌘⇧C", async ({ page }) => {
  await page.goto("/t/t-deps");
  const reply = page.getByTestId("transcript").getByTestId("message-assistant").first();
  await reply.hover();
  await reply.getByTestId("message-copy").click();
  await expect(reply.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect.poll(() => clipboard(page)).toContain("Bumped **14** packages.");

  // The Markdown of a message and a turn is `thread/copy-markdown.test.ts`'s; here the real
  // clipboard and the keyboard: the turn's menu returns focus to its button when it closes.
  await reply.getByTestId("message-more").click();
  await page.getByTestId("turn-copy").click();
  await expect.poll(() => clipboard(page)).toContain("**You**\n\nBump all minor versions");
  await page.keyboard.press("Escape");
  await expect(reply.getByTestId("message-more")).toBeFocused();

  // With keyboard focus in the user message's actions, ⌘⇧C copies that message.
  await page.evaluate(() => navigator.clipboard.writeText(""));
  const prompt = page.getByTestId("transcript").getByTestId("message-user").first();
  await prompt.getByTestId("message-copy").focus();
  await page.keyboard.press("ControlOrMeta+Shift+c");
  await expect(page.getByTestId("toast").filter({ hasText: "Copied" })).toBeVisible();
  await expect.poll(() => clipboard(page)).toBe("Bump all minor versions and run the tests.");
});
