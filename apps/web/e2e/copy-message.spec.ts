import { expect, test } from "@playwright/test";

import { clipboardText as clipboard } from "./clipboard";
import { threadRow } from "./thread-row";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("copies a message and a turn as Markdown, by button and with ⌘⇧C", async ({ page }) => {
  await page.goto("/t/t-deps");
  const reply = page.getByTestId("transcript").getByTestId("message-assistant").first();
  await reply.hover();
  await reply.getByTestId("message-copy").click();
  await expect(reply.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect.poll(() => clipboard(page)).toContain("Bumped **14** packages.");

  // The seeded reply ends its turn, so the whole turn can go too: the prompt, then the reply.
  await reply.getByTestId("message-more").click();
  await page.getByTestId("turn-copy").click();
  await expect
    .poll(() => clipboard(page))
    .toBe(
      "**You**\n\nBump all minor versions and run the tests.\n\n**Assistant**\n\n" +
        "Bumped **14** packages. All tests pass.\n\n| Package | From | To |\n|---|---|---|\n" +
        "| vitest | 5.0.0 | 5.1.2 |\n| zod | 4.6.5 | 4.7.0 |",
    );

  await expect(page.getByRole("menuitem", { name: "Copied" })).toBeVisible();
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

test("code blocks in replies have their own copy button", async ({ page }) => {
  await page.goto("/");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const [threadId] = await page.evaluate(() =>
    window.gramMock!.seedLongThreads({ count: 1, turns: 1 }),
  );
  await threadRow(page, threadId!).click();
  const code = page.getByTestId("transcript").locator('[data-streamdown="code-block"]').first();
  await expect(code).toBeVisible();
  await code.hover();
  await code.locator('[data-streamdown="code-block-copy-button"]').click();
  await expect.poll(() => clipboard(page)).toContain("export const retry = 0;");
});
