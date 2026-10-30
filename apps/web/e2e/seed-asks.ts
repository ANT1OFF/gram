import { expect, type Page } from "@playwright/test";

// What the mock's seed asks of the user outside any workspace, which Needs you counts with the
// rest: t-question's question and t-plan's plan from the start, the approval t-flaky's turn raises
// once it is opened, and t-flaky's PR, red with changes requested, until it is seen.

/**
 * Marks t-flaky's PR attention seen, as looking at the thread would, without opening it (which
 * starts its turn): the acknowledgement saved in settings, and the window told to pull them.
 */
export const seeSeedPr = (page: Page) =>
  page.evaluate(async () => {
    const mock = window.gramMock!;
    const pr = mock.world.summary("t-flaky" as never).git?.pr;
    if (pr === undefined) return;
    // `attentionOf`'s key: the red build at its head, and the review round asking for changes.
    const key = `ci:${pr.number}:${pr.headRefOid}|review:${pr.number}:${pr.review?.latestReviewId}`;
    await mock.simulateSettingsChange({ attention: { acknowledged: [`t-flaky ${key}`] } });
  });

/** Parks t-question and t-plan and sees t-flaky's PR, so the seed alone needs nothing of the user. */
export const parkSeedAsks = async (page: Page) => {
  await page.evaluate(async () => {
    for (const id of ["t-question", "t-plan"]) await window.gramMock!.park(id as never, true);
  });
  await seeSeedPr(page);
};

/** How many requests t-flaky waits on. */
export const flakyAsks = (page: Page) =>
  page.evaluate(() => window.gramMock!.world.summary("t-flaky" as never).pendingRequests.length);

/** Until t-flaky's opening turn has raised its approval, so a count read after holds still. */
export const flakyAsked = (page: Page) => expect.poll(() => flakyAsks(page)).toBeGreaterThan(0);
