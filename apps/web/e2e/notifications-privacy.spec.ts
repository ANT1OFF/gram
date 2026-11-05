import { expect, test } from "@playwright/test";

import { openNotifications } from "./open-notifications";
import { seedTheme } from "./seed-theme";

test("unsafe cached notification text is omitted and rewritten on reload while read and quieting survive", async ({
  page,
}) => {
  await seedTheme(page, { palette: "tokyo-night", mode: "dark", motion: "off" });
  await page.goto("/");
  await expect(page.getByTestId("inbox-button")).toBeVisible();
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++)
      window.gramMock?.simulateNotification({
        type: "notify",
        kind: "info",
        title: "MCP server sample didn't start: sign in required",
        startupDiagnostic: { key: "a".repeat(64), source: "Codex MCP startup" },
      });
  });
  await openNotifications(page);
  const center = page.getByRole("region", { name: "Notification history" });
  await expect(center).toContainText("Seen 3 times");
  await center.getByRole("button", { name: "Mark all read" }).click();
  await page.evaluate(() => {
    // Owned invented cache fixture only; each text field exercises sanitizing on restore.
    const state = JSON.parse(localStorage.getItem("gram.notifications.v1")!);
    state.entries[0].title = "Cookie: session=invented-cookie";
    state.entries[0].body = "Authorization: invented-arbitrary-auth";
    state.entries[0].source = "private_key=invented-private-key";
    localStorage.setItem("gram.notifications.v1", JSON.stringify(state));
  });
  await page.reload();
  await openNotifications(page);
  await expect(
    center.getByText("Sensitive notification details omitted", { exact: true }),
  ).toHaveCount(3);
  await expect(center).toContainText("Seen 3 times");
  await expect(center).toContainText("All caught up");
  expect(await page.evaluate(() => localStorage.getItem("gram.notifications.v1"))).not.toContain(
    "invented-",
  );
  await page.evaluate(() =>
    window.gramMock?.simulateNotification({
      type: "notify",
      kind: "info",
      title: "MCP startup failed: Cookie: session=invented-cookie",
      startupDiagnostic: { key: "a".repeat(64), source: "Codex MCP startup" },
    }),
  );
  await expect(center).toContainText("Seen 4 times");
  await expect(page.getByTestId("toast")).toHaveCount(0);
  await expect(center).toContainText("All caught up");
  expect(await page.evaluate(() => localStorage.getItem("gram.notifications.v1"))).not.toContain(
    "invented-",
  );
});
