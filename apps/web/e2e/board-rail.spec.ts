import { expect, test, type Page } from "@playwright/test";
import { waitForBoardLayout } from "./board-layout";
import { openOrchestrator, threadRow } from "./thread-row";

// The Board view as feature lines. Mock state lives in
// memory, so every step after the seed navigates inside the app; nothing reloads.

/** `summary` arms the helper's sentence for a feature before any view asks for it. */
const start = async (page: Page, summary?: { feature: string; text: string }) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  if (summary !== undefined) {
    await page.evaluate(
      ({ feature, text }) => window.gramMock!.simulateFeatureSummary(feature, text),
      summary,
    );
  }
  const made = await page.evaluate(() => window.gramMock!.simulateAsks());
  await openOrchestrator(page, made.orchestratorThreadId);
  await page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  await expect(page.getByTestId("rail-board")).toBeVisible();
  return made;
};

const board = (page: Page) => page.getByTestId("rail-board");
const line = (page: Page, feature: string) =>
  board(page).locator(`[data-testid="rail-row"][data-feature="${feature}"]`);
const chip = (page: Page, threadId: string) =>
  board(page).locator(`[data-testid="rail-worker"][data-thread-id="${threadId}"]`);

test("each feature is a line, its workers on the stations their cards give them", async ({
  page,
}) => {
  const made = await start(page);
  await expect(line(page, "mail-trigger")).toBeVisible();
  await expect(line(page, "registry-paging")).toBeVisible();
  await expect(line(page, "docs-refresh")).toBeVisible();

  // The three pushers wait on one ask, so their chips say they need you. Their line's group says
  // it once for its lines; a line in no group says it itself.
  for (const pusher of made.pushers) {
    await expect(chip(page, pusher)).toHaveAttribute("data-tone", "needs");
  }
  const group = board(page).getByTestId("rail-group");
  await expect(group.getByTestId("rail-group-state")).toHaveText("Needs you");
  await expect(group.getByTestId("rail-needs")).toHaveCount(0);
  await expect(line(page, "docs-refresh").getByTestId("rail-needs")).toBeVisible();
  // The line in no group is under a heading of its own, not in the band above it.
  await expect(board(page).getByTestId("rail-other")).toHaveText("Other");
  await expect(group.locator('[data-feature="docs-refresh"]')).toHaveCount(0);
  await expect(chip(page, made.inReview)).toHaveAttribute("data-station", /checks|review/);
  await expect(chip(page, made.briefed)).toBeVisible();

  // A row says no sentences: each now line is four words or fewer.
  for (const now of await board(page).getByTestId("rail-now").allTextContents()) {
    // " · " joins a wait's word to what it waits on (`waitLabel`): punctuation, not a word.
    expect(
      now
        .trim()
        .split(/\s+/)
        .filter((word) => word !== "·").length,
    ).toBeLessThanOrEqual(4);
  }
});

test("the Board's chip opens the Inbox, and an answer there clears it everywhere", async ({
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
});

test("a worker's name opens it, in Chat", async ({ page }) => {
  const made = await start(page);
  await chip(page, made.working).getByRole("button").click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.working}$`));
  await expect(page.getByTestId("view-board")).toBeHidden();
});

test("a line carries the helper's sentence on its feature, and goes without one", async ({
  page,
}) => {
  const text = "Endpoint in review, waiting on the form; three branches ready to push.";
  await start(page, { feature: "mail-trigger", text });
  await expect(line(page, "mail-trigger").getByTestId("rail-summary")).toHaveText(text);
  // No sentence for a feature the helper said nothing about: the line is complete without it.
  await expect(line(page, "registry-paging")).toBeVisible();
  await expect(line(page, "registry-paging").getByTestId("rail-summary")).toHaveCount(0);
});

test("the grid is the default, its cells side by side, and Lanes is a remembered click away", async ({
  page,
}) => {
  const made = await start(page);
  const scroller = board(page).getByTestId("rail-scroller");
  await expect(scroller).toHaveAttribute("data-layout", "grid");
  await expect(board(page).getByTestId("board-grid-heads")).toHaveText(
    /Task\s*Stage\s*Now\s*Pull request/,
  );
  // A one-worker feature is one row: its name, its stage and what it does on one line.
  const docs = line(page, "docs-refresh");
  await waitForBoardLayout(board(page));
  // Read the cells together: separate calls can compare different frames of the entrance scale.
  const { nameY, stageY, nowY } = await docs.evaluate((row) => {
    const y = (testId: string) =>
      row.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.getBoundingClientRect().y;
    return {
      nameY: y("rail-feature"),
      stageY: y("grid-stage"),
      nowY: y("rail-worker"),
    };
  });
  const stage = docs.getByTestId("grid-stage").first();
  expect(Math.abs(nowY - nameY)).toBeLessThan(12);
  expect(Math.abs(stageY - nameY)).toBeLessThan(12);
  // The Stage cell names the station the worker stands on, as the lanes place it.
  await expect(stage).toHaveAttribute(
    "data-station",
    (await docs.getByTestId("rail-worker").first().getAttribute("data-station"))!,
  );
  // A feature with several workers heads their rows, each with its own cells.
  const mail = line(page, "mail-trigger");
  await expect(mail.getByTestId("grid-workers")).toContainText("workers");
  for (const pusher of made.pushers) {
    await expect(chip(page, pusher)).toHaveAttribute("data-tone", "needs");
  }

  // Each PR said once: the Now cell leaves to the PR cell beside it a PR the cell shows.
  const repeats = await board(page)
    .getByTestId("rail-worker")
    .evaluateAll((workers) =>
      workers.flatMap((worker) => {
        const words = worker.querySelector('[data-testid="rail-now"]')?.textContent ?? "";
        const shown = [
          ...(worker.parentElement?.querySelectorAll('[data-testid="overview-pr-chip"]') ?? []),
        ].map((each) => each.getAttribute("data-pr"));
        return shown.filter((pr) => new RegExp(`#${pr}\\b`).test(words));
      }),
    );
  expect(repeats).toEqual([]);

  // Lanes: the stations as columns, kept for the next Board.
  const layouts = page.getByTestId("board-layout");
  await layouts.locator('[data-layout="lanes"]').click();
  await expect(scroller).toHaveAttribute("data-layout", /lanes|stacked/);
  await expect(board(page).getByTestId("board-grid-heads")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("gram.layout") ?? "{}").state?.boardLayout,
    ),
  ).toBe("lanes");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("view-board")).toBeHidden();
  await page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  await expect(board(page).getByTestId("rail-scroller")).toHaveAttribute(
    "data-layout",
    /lanes|stacked/,
  );
  await page.getByTestId("board-layout").locator('[data-layout="grid"]').click();
  await expect(board(page).getByTestId("rail-scroller")).toHaveAttribute("data-layout", "grid");
});
