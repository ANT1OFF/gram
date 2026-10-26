import { expect, test } from "@playwright/test";
// Quota-only real response shapes replayed offline at capture time. This is renderer qualification,
// not a new live account query. Authentication and the CLI are explicit signed-out mocks.
test.use({ locale: "en-GB", timezoneId: "Europe/Oslo" });
test("captured CLI windows show the same percentages and 24-hour resets on Usage and the title bar", async ({
  page,
}, info) => {
  const at = Date.parse("2026-10-17T13:28:01.800Z");
  // Normalized quota-only values from the capture fixture in the agents package. The parser
  // tests own raw-shape qualification; the browser consumes the server's LimitRecord contract.
  const records = [
    {
      agent: "claude",
      window: "five_hour",
      status: "allowed",
      utilization: 0.44,
      resetsAt: 1792244399684,
    },
    {
      agent: "claude",
      window: "seven_day",
      status: "allowed",
      utilization: 0.96,
      resetsAt: 1792267199684,
    },
    {
      agent: "codex",
      window: "five_hour",
      status: "allowed",
      utilization: 0,
      resetsAt: 1792244732000,
    },
    {
      agent: "codex",
      window: "seven_day",
      status: "rejected",
      utilization: 1,
      resetsAt: 1792711900000,
    },
  ].map((report) => ({ ...report, at, samples: [{ at, utilization: report.utilization }] }));
  await page.clock.install({ time: at });
  await page.addInitScript((limits) => {
    sessionStorage.setItem("gram.mock.limitRecords", JSON.stringify(limits));
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        tools: [
          { tool: "claude", found: true, path: "/mock/claude", version: "2.1.301" },
          { tool: "codex", found: true, path: "/mock/codex", version: "0.162.1" },
        ],
        claudeSignIn: "notSignedIn",
        codexSignIn: "notSignedIn",
        ghSignedIn: false,
      }),
    );
    sessionStorage.setItem("gram.mock.agentRuntimes", JSON.stringify({ agents: [] }));
  }, records);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/usage");
  await expect(page.getByTestId("usage-meter")).toHaveText("Codex 100%");
  for (const [provider, window, percent, reset] of [
    ["claude", "fiveHour", "44%", "Resets 15:39"],
    ["claude", "weekly", "96%", "Resets 21:59"],
    ["codex", "fiveHour", "0%", "Resets 15:45"],
    ["codex", "weekly", "100%", "Resets Fri 01:31"],
  ]) {
    const card = page.locator(
      `[data-testid="usage-limit-card"][data-provider="${provider}"][data-window="${window}"]`,
    );
    await expect(card.getByTestId("usage-limit-percent")).toHaveText(percent!);
    await expect(card.getByTestId("usage-limit-reset")).toHaveText(reset!);
  }
  await page.screenshot({
    path: info.outputPath("captured-subscription-limits.png"),
    fullPage: true,
  });
  await page.getByTestId("usage-meter").click();
  const popover = page.getByRole("dialog", { name: "Subscription usage" });
  await expect(popover).toContainText("44%");
  await expect(popover).toContainText("96%");
  await expect(popover).toContainText("100%");
  await expect(popover).toContainText("15:45");
});
