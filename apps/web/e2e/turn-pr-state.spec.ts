import { expect, test } from "@playwright/test";

import { openOrchestrator } from "./thread-row";

// A worker whose turn ended while its PR waits says the two apart, so a reply that ends "Done."
// never reads against a header that only says it is still waiting: the PR row over the composer
// says where the PR stands, and the title bar keeps to the worker's name and actions. With that row
// hidden, the header says both, "Turn: finished · PR: waiting on checks".

test("a worker waiting on its PR's checks says so on its PR row, else Turn: finished and PR: waiting on checks", async ({
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
  const bar = page.getByTestId("shell-titlebar");
  const wait = page.getByTestId("pr-row-wait");
  await expect(wait).toHaveText("Waiting on checks");
  await expect(wait).toHaveAttribute("title", /CI is running on/);
  await expect(bar.getByTestId("worker-now-status")).toHaveCount(0);

  // Its row hidden from the strip, the header says the turn and the PR apart.
  await page
    .getByTestId("pr-row")
    .getByRole("button", { name: /^Hide #\d+ from this thread's PR list$/ })
    .click();
  await expect(page.getByTestId("pr-row")).toHaveCount(0);
  const status = page.getByTestId("worker-now-status");
  await expect(status).toHaveAttribute("data-split", "");
  await expect(status.getByTestId("worker-turn-state")).toHaveText(/^Turn: finished/);
  await expect(status.getByTestId("worker-pr-state")).toHaveText("PR: waiting on checks");
  // The hover still lists every wait in full.
  await expect(status).toHaveAttribute("title", /CI is running on/);
});
