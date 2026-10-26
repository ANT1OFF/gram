import { expect, test, type Page } from "@playwright/test";

import { seedTheme } from "./seed-theme";

const diagnosticKey = "a".repeat(64);

/** Server events land at the next frame, which a paused clock draws only when stepped. */
const nextFrame = (page: Page) => page.clock.runFor(100);

const history = (page: Page) => page.getByRole("region", { name: "Notification history" });

/**
 * Opens the history from the bell. Its panel is among the right panel's lazily loaded tabs, which
 * React reveals on a timer once their chunk arrives, so the paused clock steps until it shows.
 */
const openHistory = async (page: Page) => {
  await page.getByTestId("notifications-bell").click();
  await expect(async () => {
    await nextFrame(page);
    await expect(history(page)).toBeVisible({ timeout: 100 });
  }).toPass();
};

test("startup repeats quietly retain history, survive reload, and remain usable without a thread", async ({
  page,
}, testInfo) => {
  // This clock/reload test exercises expiry and retention without animation frame scheduling.
  // The existing toasts.spec.ts separately exercises the normal animated dock and Escape.
  await seedTheme(page, { palette: "tokyo-night", mode: "dark", motion: "off" });
  await page.clock.install();
  await page.goto("/");
  await page.clock.pauseAt(Date.now() + 1_000);
  await expect(page.getByTestId("notifications-bell")).toBeVisible();
  await expect(page.getByTestId("right-panel")).toBeHidden();
  await page.evaluate((key) => {
    for (const threadId of ["t-flaky", "synthetic-worker-2", "synthetic-worker-3"])
      window.gramMock?.simulateNotification({
        type: "notify",
        kind: "info",
        title: "MCP server sample didn't start: sign in required",
        threadId: threadId as never,
        startupDiagnostic: { key, source: "Codex MCP startup" },
      });
  }, diagnosticKey);
  await nextFrame(page);
  await expect(page.getByTestId("toast")).toHaveCount(1);
  await expect(page.getByTestId("right-panel")).toBeHidden();
  await page.getByTestId("toast").getByRole("button", { name: "Dismiss" }).click();
  await page.clock.runFor(1000);
  await openHistory(page);
  const center = history(page);
  await expect(center.getByTestId("notification-entry")).toHaveCount(1);
  await expect(center).toContainText("Seen 3 times");
  await expect(center).toContainText("Thread no longer available");
  await expect(center.getByRole("button", { name: "Fix flaky retry test" })).toBeVisible();
  await center.getByRole("button", { name: "Mark all read" }).click();
  await expect(page.getByTestId("notifications-bell")).toHaveAccessibleName("Notifications");
  await page.reload();
  await openHistory(page);
  await expect(center).toContainText("Seen 3 times");
  await expect(page.getByTestId("toast")).toHaveCount(0);
  await page.evaluate(
    (key) =>
      window.gramMock?.simulateNotification({
        type: "notify",
        kind: "info",
        title: "MCP server sample didn't start: sign in required",
        startupDiagnostic: { key, source: "Codex MCP startup" },
      }),
    diagnosticKey,
  );
  await nextFrame(page);
  await expect(center).toContainText("Seen 4 times");
  await expect(page.getByTestId("notifications-bell")).toHaveAccessibleName("Notifications");
  await expect(page.getByTestId("toast")).toHaveCount(0);
  await page.evaluate(() => {
    window.gramMock?.simulateNotification({
      type: "notify",
      kind: "info",
      title: "New configuration warning",
      startupDiagnostic: { key: "b".repeat(64), source: "Codex configuration" },
    });
    window.gramMock?.simulateNotification({
      type: "notify",
      kind: "needsInput",
      title: "Approval needed",
      threadId: "t-flaky" as never,
    });
    window.gramMock?.simulateNotification({
      type: "notify",
      kind: "error",
      title: "Synthetic important error",
      body: "The operation failed. Inspect its thread before retrying.",
    });
  });
  await nextFrame(page);
  await expect(page.getByTestId("toast")).toHaveCount(3);
  await expect(center.getByTestId("notification-entry")).toHaveCount(4);
  await page.clock.runFor(7000);
  await expect(page.getByTestId("toast")).toHaveCount(0);
  await expect(center.getByTestId("notification-entry")).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath("notifications-wide.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  // Reopen over the content when a side panel no longer fits.
  await openHistory(page);
  const bounds = await center.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  expect(await center.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("notifications-narrow.png") });
  await center.getByRole("button", { name: "Mark all read" }).focus();
  await page.keyboard.press("Escape");
  await expect(center).toBeHidden();
  await expect(page.getByTestId("notifications-bell")).toBeFocused();
  await openHistory(page);
  await center.getByRole("button", { name: "Clear history" }).click();
  await expect(center).toContainText("No notifications yet");
  await page.evaluate(
    (key) =>
      window.gramMock?.simulateNotification({
        type: "notify",
        kind: "info",
        title: "MCP server sample didn't start: sign in required",
        startupDiagnostic: { key, source: "Codex MCP startup" },
      }),
    diagnosticKey,
  );
  await nextFrame(page);
  await expect(page.getByTestId("toast")).toHaveCount(0);
});
