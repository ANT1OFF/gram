import { expect, test } from "@playwright/test";
import { threadRow } from "./thread-row";

// This verifies the existing status renderer against synthetic runtime events. The real
// multi-provider/process isolation is exercised by the server's owned protocol regression.
test("shows a shared-child restart wait while another thread remains usable", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        claudeSignIn: "signedIn",
        codexSignIn: "signedIn",
        ghSignedIn: false,
        tools: [
          { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.296" },
          { tool: "codex", found: true, path: "/mock/bin/codex", version: "0.162.1" },
          { tool: "git", found: true, path: "/mock/bin/git", version: "2.47.1" },
          { tool: "gh", found: false },
        ],
      }),
    );
  });
  await page.goto("/t/t-release");
  await expect(threadRow(page, "t-release")).toBeVisible();
  const detail = "Waiting for the previous Codex server to exit. Other sessions can keep working.";
  await page.evaluate((waitDetail) => {
    window.gramMock!.simulateStatus("t-release" as never, "starting", waitDetail);
  }, detail);
  const waiting = page.getByRole("status").filter({ hasText: detail });
  await expect(waiting).toHaveText(detail);
  await expect(waiting).toHaveAttribute("aria-live", "polite");
  await expect(threadRow(page, "t-release")).toHaveAccessibleName("Release checklist, Starting");
  await page.screenshot({ path: testInfo.outputPath("starting-wait-detail.png") });
  await threadRow(page, "t-flaky").click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(page.getByTestId("connection-banner")).toBeHidden();
  await threadRow(page, "t-release").click();
  await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
  await expect(page.getByTestId("agent-error")).toHaveCount(0);
  await expect(waiting).toHaveText(detail);
  await page.evaluate(() => window.gramMock!.simulateStatus("t-release" as never, "idle"));
  await expect(threadRow(page, "t-release")).toHaveAccessibleName("Release checklist, Idle");
  await expect(waiting).toHaveCount(0);
  await expect(page.getByTestId("thread-starting-detail")).toHaveCount(0);
});
