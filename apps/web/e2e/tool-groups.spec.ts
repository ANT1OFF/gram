import { expect, test } from "@playwright/test";

test("native Codex web cards show supplied search, open and find metadata", async ({ page }) => {
  await page.goto("/t/t-deps");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.evaluate(() =>
    window.gramMock!.simulateMessage("t-deps" as never, {
      id: "native-web",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "WebSearch",
          toolCallId: "search",
          title: "Search web",
          state: "output-available",
          input: { action: "search", queries: ["Codex compaction", "Codex app-server"] },
          output: { action: { type: "search", queries: ["Codex compaction", "Codex app-server"] } },
          providerExecuted: true,
        },
        {
          type: "dynamic-tool",
          toolName: "WebSearch",
          toolCallId: "open",
          title: "Open page",
          state: "output-available",
          input: { action: "openPage", url: "https://example.com/docs" },
          output: { action: { type: "openPage", url: "https://example.com/docs" } },
          providerExecuted: true,
        },
        {
          type: "dynamic-tool",
          toolName: "WebSearch",
          toolCallId: "find",
          title: "Find in page",
          state: "output-error",
          input: { action: "findInPage", url: "https://example.com/docs", pattern: "compact" },
          errorText: "Search unavailable",
          providerExecuted: true,
        },
      ],
    }),
  );
  const group = page.getByTestId("tool-group").last();
  await group.getByRole("button").first().click();
  const search = group.locator('[data-tool-call-id="search"]');
  await expect(search).toContainText("Search web");
  await expect(search).toContainText("Codex compaction; Codex app-server");
  const open = group.locator('[data-tool-call-id="open"]');
  await expect(open).toContainText("Open page");
  await expect(open).toContainText("https://example.com/docs");
  await open.getByRole("button").click();
  await expect(open.locator("pre").last()).toContainText('"type": "openPage"');
  const find = group.locator('[data-tool-call-id="find"]');
  await expect(find).toContainText("Find in page");
  await expect(find).toContainText("https://example.com/docs · compact");
  await expect(find).toContainText("Error");
  await expect(find).not.toContainText("Done");
});

test("a run of tool calls folds into one line and opens to its cards", async ({ page }) => {
  await page.goto("/t/t-flaky");
  // The turn folds its finished steps once it has gone past them.
  await page.getByTestId("turn-fold").click({ timeout: 20_000 });
  const group = page.getByTestId("tool-group").first();
  const toggle = group.getByRole("button", { name: "Ran 1 command, read 1 file" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(group.getByTestId("tool-card")).toHaveCount(0);

  await toggle.click();
  await expect(group.getByTestId("tool-card")).toHaveCount(2);
  await expect(group.getByTestId("tool-card").first()).toContainText("retry.test.ts");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("an image the agent reads shows under its row, larger in the opened card, and full size", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("look at the screenshot");
  await composer.press("ControlOrMeta+Enter");

  const card = page.locator('[data-testid="tool-card"][data-tool="Read"]').last();
  await expect(card).toContainText("logo.png");
  const images = card.getByTestId("tool-images");
  await expect(images).toHaveAttribute("data-size", "thumbnail");
  const thumbnail = images.getByRole("img", { name: "logo.png" });
  // The browser decoded it: a data URL the CSP refused has no size.
  await expect
    .poll(() => thumbnail.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true);

  await card.getByRole("button", { name: /Read/ }).click();
  await expect(images).toHaveAttribute("data-size", "large");

  await images.getByTestId("attachment-thumbnail").click();
  const lightbox = page.getByTestId("attachment-lightbox");
  await expect(lightbox.getByRole("img", { name: "logo.png" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();
});
