import { expect, test, type Page } from "@playwright/test";

import type { MockWorkersSimulation } from "../src/api/mock-workers";
import { MOCK_LIVE_CATCH_UP } from "../src/api/mock-workers";
import { openOrchestrator, threadRow, upToOrchestrator } from "./thread-row";
import { openPanelTab } from "./panel-tab";

// ⌘J's Workers tab and the worker view it opens, on the mock's workers scenario. Mock state lives
// in the page, so every step navigates inside the app rather than reloading.

/** The scenario, from the orchestrator's thread, with the overview hidden as with ⌘B. */
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

const tab = (page: Page) => page.getByTestId("workers-panel");
const row = (page: Page, threadId: string) =>
  tab(page).locator(`[data-testid="workers-panel-row"][data-thread-id="${threadId}"]`);

/** ⌘J, then the worker with ⌘ held: open in the main view, as its crumbs need. */
const openWorker = async (page: Page, threadId: string) => {
  if (!(await tab(page).isVisible())) await page.keyboard.press("ControlOrMeta+KeyJ");
  await row(page, threadId).click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(new RegExp(`/t/${threadId}$`));
};

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

test("⌘J shows the Workers tab with the keys on its rows, opens a worker, and puts the panel back", async ({
  page,
}) => {
  const made = await openScenario(page);

  await page.keyboard.press("ControlOrMeta+KeyJ");
  await expect(tab(page)).toBeVisible();
  await expect(page.getByTestId("workers-panel-title")).toHaveText("Workers in agent-platform");
  // The keys are on its rows: ↑↓ move between them.
  const focused = () =>
    page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
  await expect.poll(focused).toBe("workers-panel-row");
  const first = await page.evaluate(() => document.activeElement?.getAttribute("data-thread-id"));
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-thread-id")))
    .not.toBe(first);
  await page.keyboard.press("Home");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-thread-id")))
    .toBe(first);

  // Each row says its state under its title, and the finished ones are under Done.
  await expect(row(page, made.live).getByTestId("workers-panel-status")).not.toBeEmpty();
  await expect(tab(page).getByTestId("workers-group-done")).toHaveAttribute("data-count", /^[1-9]/);

  // ⌘J again puts the panel back as it was: hidden here.
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await expect(tab(page)).toBeHidden();

  // ⌘J, then ⌘⏎ on a row: the worker in the main view.
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await expect(row(page, made.live)).toBeVisible();
  // The tab's opening transition can still leave its rows inert; wait until this row takes keys.
  await expect
    .poll(async () => {
      await row(page, made.live).focus();
      return row(page, made.live).evaluate((target) => document.activeElement === target);
    })
    .toBe(true);
  await row(page, made.live).press("ControlOrMeta+Enter");
  await expect(page).toHaveURL(new RegExp(`/t/${made.live}$`));
  const crumbs = page.getByTestId("worker-crumbs");
  await expect(crumbs).toContainText("agent-platform");
  await expect(crumbs).toContainText("mail-retry-policy");
  await expect(crumbs).toContainText("Retry with backoff");

  // Another dialog keeps ⌘J out: it doesn't move the keys from the palette.
  await page.keyboard.press("ControlOrMeta+KeyK");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await expect(page.getByTestId("command-palette")).toBeVisible();
});

test("a worker's crumbs lead to its feature and its siblings, and the switcher up to its orchestrator", async ({
  page,
}) => {
  const made = await openScenario(page);
  // Wide enough for the title bar to keep the feature crumb beside the worker's name.
  await page.setViewportSize({ width: 1680, height: 900 });
  await openWorker(page, made.asking);
  // Beside the Files tab: a review opens wider and leaves the chat, and its title bar, 800 px.
  await openPanelTab(page.getByTestId("right-panel"), "Files");

  // The worker's name shows every worker: the Workers tab.
  await page.getByTestId("worker-crumb-worker").click();
  await expect(tab(page)).toBeVisible();

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
  await openWorker(page, made.live);

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
  await openWorker(page, made.live);
  const catchUp = page.getByTestId("worker-catch-up");
  await expect(catchUp).toContainText(MOCK_LIVE_CATCH_UP);
  await expect(catchUp).toHaveAttribute("data-source", "helper");
  await page.getByTestId("transcript").hover();
  await page.mouse.wheel(0, -1200);
  await page.getByTestId("jump-to-live").click();
  await expect(page.getByTestId("worker-hold")).toHaveCount(0);
  expect(await isHeld(page, made, made.live)).toBe(false);

  // A worker whose report has no helper catch-up shows that report's own words.
  await openWorker(page, made.asking);
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
  await expect(hold).toContainText("Under your control");
  expect(await isHeld(page, made, made.asking)).toBe(true);

  // Hand back clears it.
  await hold.getByRole("button", { name: "Hand back" }).click();
  await expect(hold).toHaveCount(0);
  await expect.poll(() => isHeld(page, made, made.asking)).toBe(false);

  // The board's held worker shows the chip, not the old banner, and hands back the same way.
  await openWorker(page, made.held);
  await expect(page.getByTestId("worker-hold")).toBeVisible();
  await expect(page.getByTestId("worker-banner-intervened")).toHaveCount(0);
  await page.getByTestId("worker-hand-back").click();
  await expect(page.getByTestId("worker-hold")).toHaveCount(0);
  await expect.poll(() => isHeld(page, made, made.held)).toBe(false);
});
