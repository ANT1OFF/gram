import { expect, test } from "@playwright/test";

import { openOrchestrator } from "./thread-row";

// Under the Board's lines, the Done band: what has left the Board for Done, a line each with the PR
// it ended with, and a way to bring it back as lines. Over the realistic scenario.

test("the Board lists finished work under its lines, and brings it back on asking", async ({
  page,
}) => {
  await page.addInitScript(() => sessionStorage.setItem("gram.mock.orchestration", "realistic"));
  await page.setViewportSize({ width: 1728, height: 1000 });
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  const made = await page.evaluate(async () => {
    const started = await window.gramMock!.startedRealistic();
    if (started === undefined)
      throw new Error("the mock did not start with the realistic scenario");
    return started;
  });
  await openOrchestrator(page, made.orchestratorThreadId);
  await page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  const board = page.getByTestId("rail-board");
  const done = board.getByTestId("board-done");
  await expect(done).toBeVisible();
  const notes = done.getByTestId("board-done-row").filter({ hasText: "Release notes for 0.9" });
  await expect(notes.getByTestId("board-done-pr")).toHaveText("#61 merged");
  // Below the lines at work, not among them.
  const last = (await board.getByTestId("rail-row").last().boundingBox())!;
  expect((await done.boundingBox())!.y).toBeGreaterThan(last.y);

  // The Pull request column sits after Now, not at the window's far edge.
  const heads = board.getByTestId("board-grid-heads");
  const pr = (await heads.getByText("Pull request").boundingBox())!;
  expect(pr.x).toBeLessThan(1728 * 0.7);

  // Show on the Board brings them back as lines, and the band gives way to them.
  await done.getByTestId("board-done-show").click();
  await expect(done).toHaveCount(0);
  await expect(board.locator('[data-testid="rail-row"][data-finished]').first()).toBeVisible();
});
