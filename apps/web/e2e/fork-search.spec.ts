import { expect, test, type Page } from "@playwright/test";

import { flashedTexts, recordFlashes } from "./flash-recorder";
import { threadRow } from "./thread-row";

test("forks at a reply into a new thread with the history up to it", async ({ page }) => {
  // A solo thread's header shares the title bar with the window's controls, and drops its fork
  // link and port chips when narrow: a wide window keeps them in sight.
  await page.setViewportSize({ width: 1680, height: 720 });
  await page.goto("/t/t-deps");
  const transcript = page.getByTestId("transcript");
  await expect(transcript).toContainText("Bumped 14 packages");

  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("also update the changelog");
  await composer.press("ControlOrMeta+Enter");
  await expect(
    page.getByTestId("message-user").filter({ hasText: "also update the changelog" }),
  ).toBeVisible();

  const reply = page.getByTestId("message-assistant").filter({ hasText: "Bumped 14 packages" });
  await reply.hover();
  await reply.getByTestId("message-fork").click();

  await expect(page).not.toHaveURL(/\/t\/t-deps$/);
  await expect(page.getByTestId("pane-header")).toContainText("Fork of");
  await expect(page.getByTestId("forked-from")).toBeVisible();
  await expect(transcript).toContainText("Bumped 14 packages");
  await expect(transcript).not.toContainText("also update the changelog");

  await page.getByTestId("forked-from").click();
  await expect(page).toHaveURL(/\/t\/t-deps$/);
});

test("finds a message from ⌘K, then within the thread with ⌘F", async ({ page }) => {
  await recordFlashes(page);
  await page.goto("/");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Go to, or > for commands").fill("dark mode toggle");

  const hit = page.getByRole("group", { name: "Messages" }).getByRole("option").first();
  await expect(hit).toContainText("dark mode toggle");
  await hit.click();

  await expect(page).toHaveURL(/\/t\/t-dark$/);
  const flashed = () => flashedTexts(page);
  await expect.poll(flashed).toContainEqual(expect.stringContaining("dark mode toggle"));

  await page.keyboard.press("ControlOrMeta+f");
  await page.getByLabel("Find in thread").fill("localStorage");
  await expect(page.getByTestId("find-status")).toHaveText("1 of 1");
  await expect.poll(flashed).toContainEqual(expect.stringContaining("localStorage"));
});

/** Adds a thread of `turns` generated turns and opens it from the sidebar, keeping the mock. */
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

test("a long thread opens on its recent turns and pages older ones in as it scrolls up", async ({
  page,
}) => {
  const id = await openLongThread(page, 45);
  const transcript = page.getByTestId("transcript");
  const earlier = transcript.getByRole("button", { name: "Show earlier messages" });
  await expect(page.locator(`[data-message-id="${id}-u0"]`)).toHaveCount(0);
  // The first page goes in above the oldest turn loaded, which stays in view.
  await transcript.evaluate((el) => el.scrollTo({ top: 0 }));
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);
  await expect(page.locator(`[data-message-id="${id}-u25"]`)).toBeInViewport();
  await expect
    .poll(async () => {
      await transcript.evaluate((el) => el.scrollTo({ top: 0 }));
      return earlier.count();
    })
    .toBe(0);
  // The last page went in above the view too.
  await transcript.evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(page.locator(`[data-message-id="${id}-u0"]`)).toBeVisible();
});

test("find in a long thread pages back to a hit older than what's loaded", async ({ page }) => {
  await recordFlashes(page);
  // 25 turns: the window holds the last 20, and only turn 0 has "0:" and "retry".
  await openLongThread(page, 25);
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByLabel("Find in thread").fill("Turn 0: retry");
  await expect(page.getByTestId("find-status")).toHaveText("1 of 1");
  await expect.poll(() => flashedTexts(page)).toContainEqual(expect.stringContaining("Turn 0:"));
});
