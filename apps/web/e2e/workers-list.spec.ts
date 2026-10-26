import { expect, test, type Page } from "@playwright/test";

import type { MockWorkersSimulation } from "../src/api/mock-workers";
import { MOCK_LIVE_CATCH_UP } from "../src/api/mock-workers";
import { openOrchestrator, threadRow, upToOrchestrator } from "./thread-row";

// ⌘J's Workers list and the worker view it opens, on the mock's workers scenario. Mock state lives
// in the page, so every step navigates inside the app rather than reloading.

/**
 * The scenario, from the orchestrator's thread: home, where ⌘J is two steps from any worker. The
 * overview is hidden, as with ⌘B: open, ⌘J jumps into its worker rows rather than this list.
 */
const openScenario = async (page: Page): Promise<MockWorkersSimulation> => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(async () => {
    const mock = window.gramMock;
    if (!mock) throw new Error("the mock API isn't on this page");
    return mock.simulateWorkers();
  });
  await openOrchestrator(page, made.orchestratorThreadId);
  await page.getByTestId("overview-hide").click();
  await expect(page.getByTestId("overview-sidebar")).toHaveCount(0);
  return made;
};

const list = (page: Page) => page.getByTestId("workers-list");
const row = (page: Page, threadId: string) =>
  list(page).locator(`[data-testid="worker-row"][data-thread-id="${threadId}"]`);

const isHeld = (page: Page, made: MockWorkersSimulation, threadId: string) =>
  page.evaluate(
    async ({ workspaceId, worker }) => {
      const ledger = await window.gramMock!.orchestratorLedger(workspaceId);
      return ledger.features
        .flatMap((feature) => feature.workers)
        .find((entry) => entry.threadId === worker)?.userIntervened;
    },
    { workspaceId: made.workspaceId, worker: threadId },
  );

test("⌘J lists every worker by section and feature, and opens one in two steps", async ({
  page,
}) => {
  const made = await openScenario(page);

  await page.keyboard.press("ControlOrMeta+KeyJ");
  await expect(list(page)).toBeVisible();
  await expect(list(page)).toContainText("agent-platform");
  const now = page.getByTestId("workers-section-now");
  await expect(now).toBeVisible();

  // Now: grouped by feature, each with a short now line from its activity or report.
  await expect(now.getByRole("group", { name: "mail-retry-policy" })).toBeVisible();
  await expect(row(page, made.live).getByTestId("worker-now")).toHaveText("running tests");
  await expect(row(page, made.live)).toContainText("api");
  await expect(row(page, made.asking).getByTestId("worker-now")).toHaveText("asked a question");
  await expect(row(page, made.held).getByLabel("You hold it")).toBeVisible();
  for (const line of await list(page).getByTestId("worker-now").allTextContents()) {
    expect(line.replace(/…$/, "").trim().split(/\s+/).length, line).toBeLessThanOrEqual(4);
  }
  await expect(
    now
      .getByTestId("worker-row")
      .filter({ has: page.locator(`[data-thread-id="${made.doneToday}"]`) }),
  ).toHaveCount(0);

  // Done today and Earlier are sections of the same list, a click away without a tab.
  const doneToday = page.getByTestId("workers-section-doneToday");
  await expect(
    doneToday.locator(`[data-thread-id="${made.doneToday}"]`).getByTestId("worker-now"),
  ).toHaveText(/^merged \d{2}:\d{2}$/);
  const earlier = page.getByTestId("workers-section-earlier");
  for (const id of made.earlier)
    await expect(earlier.locator(`[data-thread-id="${id}"]`)).toBeAttached();

  // The search box filters every section.
  const search = page.getByTestId("workers-search");
  await expect(search).toBeFocused();
  await search.fill("uv");
  await expect(row(page, made.earlier[0]!)).toBeVisible();
  await expect(row(page, made.live)).toHaveCount(0);
  // While typing, Home and End move the caret; only ↑↓ and Return belong to the list.
  await page.keyboard.press("Home");
  await expect.poll(() => search.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(0);
  await page.keyboard.press("End");
  await expect.poll(() => search.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(2);
  await expect(row(page, made.earlier[1]!)).toHaveCount(0);
  await search.fill("no such worker");
  await expect(list(page)).toContainText("No matches");
  await search.fill("");

  // Two steps from the orchestrator: ⌘J, then the worker.
  await row(page, made.live).click();
  await expect(list(page)).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/t/${made.live}$`));
  const crumbs = page.getByTestId("worker-crumbs");
  await expect(crumbs).toContainText("agent-platform");
  await expect(crumbs).toContainText("mail-retry-policy");
  await expect(crumbs).toContainText("Retry with backoff");

  // ⌘J again toggles it, and the keyboard alone opens a worker too.
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await expect(list(page)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await expect(list(page)).toBeHidden();
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(list(page)).toBeHidden();
  await expect(page).not.toHaveURL(new RegExp(`/t/${made.live}$`));
  await expect(page.getByTestId("worker-crumbs")).toBeVisible();

  // Another dialog keeps ⌘J out: it doesn't open the list over the palette.
  await page.keyboard.press("ControlOrMeta+KeyK");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await expect(list(page)).toBeHidden();
  await expect(page.getByTestId("command-palette")).toBeVisible();
});

test("a worker's crumbs lead to its feature and its siblings, and the switcher up to its orchestrator", async ({
  page,
}) => {
  const made = await openScenario(page);
  // Wide enough for the title bar to keep the feature crumb beside the worker's name.
  await page.setViewportSize({ width: 1680, height: 900 });
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await row(page, made.asking).click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.asking}$`));

  await page.getByTestId("worker-crumb-worker").click();
  await expect(list(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list(page)).toBeHidden();

  // The feature opens its sheet over the worker, and Esc gives focus back to the crumb.
  const featureCrumb = page.getByTestId("worker-crumb-feature");
  await featureCrumb.click();
  const sheet = page.getByTestId("feature-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute("data-feature", "rate-headers");
  await expect(page).toHaveURL(new RegExp(`/t/${made.asking}$`));
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(featureCrumb).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/t/${made.asking}$`));

  // The switcher beside the crumbs names the workspace, and goes up to its orchestrator.
  await upToOrchestrator(page, made.orchestratorThreadId);
});

test("Following live pauses when you scroll up, and Jump to live follows again", async ({
  page,
}) => {
  const made = await openScenario(page);
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await row(page, made.live).click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.live}$`));

  const pill = page.getByTestId("following-live");
  await expect(pill).toHaveText("Following live");
  // The dot breathes only while text streams in.
  const dot = pill.getByTestId("following-live-dot");
  await expect(dot).toHaveAttribute("data-streaming", "false");
  await page.evaluate((id) => {
    window.gramMock!.simulateChunks(id as never, "live-reply" as never, [
      { type: "start", messageId: "live-reply" },
      { type: "text-start", id: "live-text" },
      { type: "text-delta", id: "live-text", delta: "40 of 52 pass so far. " },
    ]);
  }, made.live);
  await expect(dot).toHaveAttribute("data-streaming", "true");
  await expect(dot).toHaveClass(/gram-breathe/);

  // Reading back pauses following; the worker is not told and not held.
  const transcript = page.getByTestId("transcript");
  await transcript.hover();
  await page.mouse.wheel(0, -1200);
  const jump = page.getByTestId("jump-to-live");
  await expect(jump).toBeVisible();
  await expect(pill).toHaveCount(0);
  await page.evaluate((id) => {
    window.gramMock!.simulateChunks(id as never, "live-reply" as never, [
      { type: "text-delta", id: "live-text", delta: "Still running test_consumer.py. ".repeat(20) },
    ]);
  }, made.live);
  await expect(jump).toBeVisible();

  await jump.click();
  await expect(pill).toBeVisible();
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop <= 1))
    .toBe(true);

  // The turn ends: the dot stops, and nothing live is left to follow.
  await page.evaluate((id) => {
    window.gramMock!.simulateChunks(id as never, "live-reply" as never, [
      { type: "text-end", id: "live-text" },
      { type: "finish" },
    ]);
    window.gramMock!.simulateStatus(id as never, "idle");
  }, made.live);
  await expect(page.getByTestId("following-live")).toHaveCount(0);
  await expect(page.getByTestId("jump-to-live")).toHaveCount(0);
});

test("watching a worker never holds it; a message does, and Hand back returns it", async ({
  page,
}) => {
  const made = await openScenario(page);
  expect(await isHeld(page, made, made.live)).toBe(false);

  // Open it, read the catch-up, scroll, jump back, open its panels: still the orchestrator's.
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await row(page, made.live).click();
  const catchUp = page.getByTestId("worker-catch-up");
  await expect(catchUp).toContainText(MOCK_LIVE_CATCH_UP);
  await expect(catchUp).toHaveAttribute("data-source", "helper");
  await page.getByTestId("transcript").hover();
  await page.mouse.wheel(0, -1200);
  await page.getByTestId("jump-to-live").click();
  await expect(page.getByTestId("worker-hold")).toHaveCount(0);
  expect(await isHeld(page, made, made.live)).toBe(false);

  // A worker whose report has no helper catch-up shows that report's own words.
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await row(page, made.asking).click();
  await expect(page.getByTestId("worker-catch-up")).toHaveAttribute("data-source", "report");
  await expect(page.getByTestId("worker-catch-up")).toContainText(
    "Should Retry-After be seconds or an HTTP date?",
  );
  expect(await isHeld(page, made, made.asking)).toBe(false);

  // Sending it a message is what holds it.
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("Use seconds.");
  await page.keyboard.press("ControlOrMeta+Enter");
  const hold = page.getByTestId("worker-hold");
  await expect(hold).toContainText("You hold it");
  expect(await isHeld(page, made, made.asking)).toBe(true);

  // Hand back clears it.
  await hold.getByRole("button", { name: "Hand back" }).click();
  await expect(hold).toHaveCount(0);
  await expect.poll(() => isHeld(page, made, made.asking)).toBe(false);

  // The board's held worker shows the chip, not the old banner, and hands back the same way.
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await row(page, made.held).click();
  await expect(page.getByTestId("worker-hold")).toBeVisible();
  await expect(page.getByTestId("worker-banner-intervened")).toHaveCount(0);
  await page.getByTestId("worker-hand-back").click();
  await expect(page.getByTestId("worker-hold")).toHaveCount(0);
  await expect.poll(() => isHeld(page, made, made.held)).toBe(false);
});
