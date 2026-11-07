import { expect, test } from "@playwright/test";

import { openOrchestrator } from "./thread-row";

// A worker whose turn ended while its PR waits says the two apart in its header, so a reply that
// ends "Done." never reads against a header that only says it is still waiting.

test("a worker waiting on its PR's checks says Turn: finished and PR: waiting on checks", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateWaitingOn());
  await openOrchestrator(page, made.orchestratorThreadId);
  await page
    .locator(`[data-testid="overview-worker"][data-thread-id="${made.ci}"]`)
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.ci}$`));
  const status = page.getByTestId("worker-now-status");
  await expect(status).toHaveAttribute("data-split", "");
  await expect(status.getByTestId("worker-turn-state")).toHaveText(/^Turn: finished/);
  await expect(status.getByTestId("worker-pr-state")).toHaveText("PR: waiting on checks");
  // The hover still lists every wait in full.
  await expect(status).toHaveAttribute("title", /CI is running on/);
});
