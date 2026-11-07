import { expect, test, type Page } from "@playwright/test";

import { threadRow } from "./thread-row";

/** Adds a thread of `turns` generated turns, every one loaded, and opens it from the sidebar. */
async function openLongThread(page: Page, turns: number) {
  await page.goto("/");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const [id] = await page.evaluate(
    (t) => window.gramMock!.seedLongThreads({ count: 1, turns: t }),
    turns,
  );
  await threadRow(page, id!).click();
  await expect(page.locator(`[data-message-id="${id}-u${turns - 1}"]`)).toBeVisible();
  return id!;
}

/** The text find marks as its current match, through the CSS Custom Highlight API. */
const currentMatch = (page: Page) =>
  page.evaluate(() => {
    const highlight = CSS.highlights.get("gram-find-current");
    const [range] = highlight ? [...highlight] : [];
    return range?.toString();
  });

const markedCount = (page: Page) => page.evaluate(() => CSS.highlights.get("gram-find")?.size ?? 0);

test("finds a match in a row the transcript hasn't drawn, marks it, and Esc goes back", async ({
  page,
}) => {
  const id = await openLongThread(page, 20);
  const transcript = page.getByTestId("transcript");
  const early = transcript.locator(`[data-message-id="${id}-a3"]`);
  const latest = transcript.locator(`[data-message-id="${id}-a19"]`);
  // Loaded, but outside the rows the virtualised transcript draws.
  await expect(early).toHaveCount(0);
  await expect(latest).toBeInViewport();

  await page.keyboard.press("ControlOrMeta+f");
  const field = page.getByLabel("Find in thread");
  await expect(field).toBeFocused();
  await field.fill("turn 3 is done");
  await expect(page.getByTestId("find-status")).toHaveText("1 of 1");
  await expect(early).toBeInViewport();
  await expect.poll(() => currentMatch(page)).toBe("Turn 3 is done");
  await expect(latest).not.toBeInViewport();

  // A word every turn says: counted across all of them, drawn or not, the newest first.
  await field.fill("is done");
  await expect(page.getByTestId("find-status")).toHaveText("20 of 20");
  await expect(latest).toBeInViewport();
  await expect.poll(() => markedCount(page)).toBeGreaterThan(0);
  await field.press("Enter");
  await expect(page.getByTestId("find-status")).toHaveText("19 of 20");
  await field.press("Shift+Enter");
  await field.press("Shift+Enter");
  await expect(page.getByTestId("find-status")).toHaveText("1 of 20");
  await expect(transcript.locator(`[data-message-id="${id}-a0"]`)).toBeInViewport();

  // Esc: back to the bottom, where find opened, with the marks gone.
  await field.press("Escape");
  await expect(page.getByTestId("find-bar")).toBeHidden();
  await expect(latest).toBeInViewport();
  await expect.poll(() => markedCount(page)).toBe(0);
});

test("a match in a closed tool card's output opens the card; the close button stays there", async ({
  page,
}) => {
  const id = await openLongThread(page, 6);
  const transcript = page.getByTestId("transcript");
  await page.keyboard.press("ControlOrMeta+f");
  const field = page.getByLabel("Find in thread");
  // Only the Bash runs' input says it, each in a card that starts closed.
  await field.fill("pnpm vitest run");
  await expect(page.getByTestId("find-status")).toHaveText("6 of 6");
  await expect(page.getByTestId("find-in-tool")).toHaveText("In tool output");
  const card = transcript.locator(`[data-tool-call-id="${id}-bash-5"]`);
  await expect(card).toBeVisible();
  await expect(card.locator("button").first()).toHaveAttribute("data-panel-open", "");

  await page.getByRole("button", { name: "Close find, staying here" }).click();
  await expect(page.getByTestId("find-bar")).toBeHidden();
  await expect(card).toBeInViewport();
});
