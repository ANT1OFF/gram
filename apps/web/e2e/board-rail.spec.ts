import { expect, test, type Page } from "@playwright/test";
import { openOrchestrator, threadRow } from "./thread-row";

// The Board view as feature lines, wired to the Inbox and the threads. How a line draws its
// workers, stations, needs mark and summary is `src/views/board-grid.test.tsx`'s; which workers
// and stations a line has is `rail-model.test.ts`'s. Mock state lives in memory, so every step
// after the seed navigates inside the app; nothing reloads.

const pickBoard = (page: Page) =>
  page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();

const start = async (page: Page) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(() => window.gramMock!.simulateAsks());
  await openOrchestrator(page, made.orchestratorThreadId);
  await pickBoard(page);
  await expect(page.getByTestId("rail-board")).toBeVisible();
  return made;
};

const board = (page: Page) => page.getByTestId("rail-board");
const chip = (page: Page, threadId: string) =>
  board(page).locator(`[data-testid="rail-worker"][data-thread-id="${threadId}"]`);

test("the Board's chip opens the Inbox, an answer there clears it everywhere, and a worker's name opens it", async ({
  page,
}) => {
  const made = await start(page);
  // No dock below the lines: the header's chip is the Board's one way to what waits on you.
  await expect(board(page).getByTestId("ask-stack")).toHaveCount(0);
  const waiting = page.getByTestId("rail-waiting-chip");
  const before = Number(await waiting.getAttribute("data-count"));
  await waiting.click();
  const push = page.getByTestId("inbox-item").filter({ hasText: "feat/mail-trigger" });
  await push.click();
  // Approvals show the exact command.
  const ask = page.getByTestId("inbox-detail").getByTestId("ask-item");
  await expect(ask).toContainText("git push -u origin feat/mail-trigger");
  await ask.getByRole("button", { name: /^Allow/ }).click();
  await expect(push).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(waiting).toHaveAttribute("data-count", String(before - 1));
  await expect(chip(page, made.pushers[0])).not.toHaveAttribute("data-tone", "needs");

  // Back in Chat, the workspace's line in the sidebar has lost it too.
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="overview-workspace"][data-current]')).toHaveAttribute(
    "data-asks",
    String(before - 1),
  );

  // A worker's name on the Board opens its thread, in Chat.
  await pickBoard(page);
  await chip(page, made.working).getByRole("button").click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.working}$`));
  await expect(page.getByTestId("view-board")).toBeHidden();
});
