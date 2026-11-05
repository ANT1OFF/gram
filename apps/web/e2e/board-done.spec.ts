import { expect, test } from "@playwright/test";

import { waitForBoardLayout } from "./board-layout";
import { openOrchestrator } from "./thread-row";

// Under the Board's lines, the Done band: what has left the Board for Done, a line each with the PR
// it ended with; the header's Show finished brings it back as lines. Over the realistic scenario.

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
  await waitForBoardLayout(board);
  // One snapshot of the settled Board, rather than boxes from different entrance-animation frames.
  const { lastY, doneY, prX, donePrX } = await notes.evaluate((row) => {
    const root = row.closest('[data-testid="rail-board"]')!;
    const lines = root.querySelectorAll('[data-testid="rail-row"]');
    const heads = root.querySelector('[data-testid="board-grid-heads"]')!;
    return {
      lastY: lines[lines.length - 1]!.getBoundingClientRect().y,
      doneY: row.closest('[data-testid="board-done"]')!.getBoundingClientRect().y,
      prX: heads.querySelector("span:last-child")!.getBoundingClientRect().x,
      donePrX: row.querySelector('[data-testid="board-done-pr"]')!.getBoundingClientRect().x,
    };
  });
  // Below the lines at work, not among them.
  expect(doneY).toBeGreaterThan(lastY);

  // The Pull request column sits after Now, not at the window's far edge.
  expect(prX).toBeLessThan(1728 * 0.7);

  // On the grid's columns: a finished task's PR sits under Pull request.
  expect(Math.abs(donePrX - prX)).toBeLessThan(2);

  // Five rows, then the rest unfold in place.
  const rows = done.getByTestId("board-done-row");
  await expect(rows).toHaveCount(5);
  await done.getByTestId("board-done-more").click();
  await expect(rows).toHaveCount(6);
  await expect(done.getByTestId("board-done-more")).toHaveCount(0);

  // The band names no place it is already in: the header's Show finished brings them back as
  // lines, and the band gives way to them.
  await expect(done).not.toContainText("on the Board");
  await page.getByTestId("rail-show-archived").click();
  await expect(done).toHaveCount(0);
  await expect(board.locator('[data-testid="rail-row"][data-finished]').first()).toBeVisible();
});
