import type { Page } from "@playwright/test";

import { openOrchestrator, threadRow } from "../e2e/thread-row";

/** Board in the title bar's view switcher. */
export const openBoardView = async (page: Page) => {
  await page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  await page.getByTestId("view-board").waitFor();
};

/**
 * The mock's "board" workspace beside the seeded threads, with the window tall enough for a long
 * menu. Resolves with the thread ids the scenario made.
 */
export const openBoardSidebar = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/t/t-flaky");
  await threadRow(page, "t-flaky").waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOrchestration("board"));
  await openOrchestrator(page, made.orchestratorThreadId);
  await threadRow(page, made.working).waitFor();
  return made;
};
