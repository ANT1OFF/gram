import { expect, test, type Page } from "@playwright/test";
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
  await expect(chip(page, made.inReview)).toHaveAttribute("data-station", /checks|review/);
  await expect(chip(page, made.briefed)).toBeVisible();

  // A row says no sentences: each now line is four words or fewer.
  for (const now of await board(page).getByTestId("rail-now").allTextContents()) {
    expect(now.trim().split(/\s+/).length).toBeLessThanOrEqual(4);
  }
});

test("the ask stack docks below the lines, and an answer there clears it everywhere", async ({
  page,
}) => {
  const made = await start(page);
  const stack = board(page).getByTestId("ask-stack");
  await expect(stack).toBeVisible();
  // Below the lines, not above them.
  const lines = await board(page)
    .getByRole("list", { name: "Features", exact: true })
    .boundingBox();
  const docked = await stack.boundingBox();
  expect(docked!.y).toBeGreaterThan(lines!.y);

  const before = Number(await stack.getByTestId("ask-stack-count").textContent());
  await stack.getByTestId("ask-expand").click();
  const push = stack.getByTestId("ask-item").filter({ hasText: "git push" });
  // Approvals show the exact command.
  await expect(push).toContainText("git push -u origin feat/mail-trigger");
  await push.getByRole("button", { name: /^Allow/ }).click();
  await expect(stack.getByTestId("ask-stack-count")).toHaveText(String(before - 1));
  await expect(chip(page, made.pushers[0])).not.toHaveAttribute("data-tone", "needs");

  // Back in Chat, the orchestrator's own stack has lost it too.
  await page.keyboard.press("Escape");
  await expect(
    page.locator("[data-pane-root]").getByTestId("ask-stack").getByTestId("ask-stack-count"),
  ).toHaveText(String(before - 1));
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
