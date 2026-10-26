import { expect, type Page } from "@playwright/test";

// What the mock's seed asks of the user outside any workspace, which Needs you counts with the
// rest: t-question's question and t-plan's plan from the start, and the approval t-flaky's turn
// raises once it is opened.

/** Parks t-question and t-plan, so the seed alone has nothing that needs the user. */
export const parkSeedAsks = (page: Page) =>
  page.evaluate(async () => {
    for (const id of ["t-question", "t-plan"]) await window.gramMock!.park(id as never, true);
  });

/** How many requests t-flaky waits on. */
export const flakyAsks = (page: Page) =>
  page.evaluate(() => window.gramMock!.world.summary("t-flaky" as never).pendingRequests.length);

/** Until t-flaky's opening turn has raised its approval, so a count read after holds still. */
export const flakyAsked = (page: Page) => expect.poll(() => flakyAsks(page)).toBeGreaterThan(0);
