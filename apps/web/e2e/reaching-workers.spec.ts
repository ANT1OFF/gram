import { expect, test, type Page } from "@playwright/test";

import { MOCK_STUCK_TEXT, type MockReachingSimulation } from "../src/api/mock-reaching";
import { openOrchestrator, threadRow } from "./thread-row";

// Reaching workers beyond ⌘J: keeping one beside the chat (⌘\), Take over, a worker whose worktree
// was cleaned up, and "Why is it stuck?". None of the ways to look at a worker holds it, and nothing
// here sends a message: a nudge or "Ask about it" only fills a composer.

const MOCK_SETTINGS_KEY = "gram.mock.settings";

const withSettings = (page: Page, settings: object) =>
  page.addInitScript(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
    key: MOCK_SETTINGS_KEY,
    value: settings,
  });

const open = async (page: Page, helpers: object = {}): Promise<MockReachingSimulation> => {
  await withSettings(page, { helpers });
  // Wide enough that the title bar keeps Workers, Keep beside and Take over out of its folded "…".
  await page.setViewportSize({ width: 1680, height: 900 });
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(() => window.gramMock!.simulateReachingWorkers());
  await openOrchestrator(page, made.orchestratorThreadId);
  return made;
};

const list = (page: Page) => page.getByTestId("workers-list");
const row = (page: Page, threadId: string) =>
  list(page).locator(`[data-testid="worker-row"][data-thread-id="${threadId}"]`);
const pane = (page: Page, threadId: string) =>
  page.locator(`[data-testid="pane"][data-thread-id="${threadId}"]`);
const composerOf = (page: Page, threadId: string) =>
  pane(page, threadId).getByLabel("Message", { exact: true });

const isHeld = (page: Page, made: MockReachingSimulation, threadId: string) =>
  page.evaluate(
    async ({ workspaceId, worker }) => {
      const ledger = await window.gramMock!.orchestratorLedger(workspaceId);
      return ledger.features
        .flatMap((feature) => feature.workers)
        .find((entry) => entry.threadId === worker)?.userIntervened;
    },
    { workspaceId: made.workspaceId, worker: threadId },
  );

/**
 * The Workers list, from the title bar's Workers button: with the overview open, ⌘J jumps into the
 * overview's worker rows instead.
 */
const openList = async (page: Page) => {
  await page.getByTestId("workers-button").click();
  await expect(list(page)).toBeVisible();
};

const openWorker = async (page: Page, threadId: string) => {
  await openList(page);
  await row(page, threadId).click();
  await expect(pane(page, threadId)).toBeVisible();
};

test("⌘\\ keeps a worker beside the chat without holding it or taking typing", async ({ page }) => {
  const made = await open(page);
  await openWorker(page, made.live);

  await page.keyboard.press("ControlOrMeta+Backslash");
  const dock = page.getByTestId("beside-dock");
  await expect(dock).toHaveAttribute("data-thread-id", made.live);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  // The orchestrator's composer has the keyboard, and what you type goes there.
  const composer = composerOf(page, made.orchestratorThreadId);
  await expect(composer).toBeFocused();
  await page.keyboard.type("Tell me when it's green");
  await expect(composer).toHaveValue("Tell me when it's green");
  // The dock watches: its log, its last command, its changes, and no composer of its own.
  await expect(dock.getByLabel("Message", { exact: true })).toHaveCount(0);
  await dock.getByTestId("beside-tab-terminal").click();
  await expect(composer).toHaveValue("Tell me when it's green");
  await dock.getByTestId("beside-tab-log").click();
  expect(await isHeld(page, made, made.live)).toBe(false);

  // ⌘\ again undocks; from the orchestrator it brings the same worker back; Close undocks too.
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(dock).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(dock).toHaveAttribute("data-thread-id", made.live);
  await dock.getByTestId("beside-close").click();
  await expect(dock).toHaveCount(0);

  // ⌘⏎ in the Workers list docks the selected worker.
  await openList(page);
  await row(page, made.asking).hover();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(dock).toHaveAttribute("data-thread-id", made.asking);
  expect(await isHeld(page, made, made.live)).toBe(false);
  expect(await isHeld(page, made, made.asking)).toBe(false);
});

test("Take over holds a worker without a message, and Hand back returns it", async ({ page }) => {
  const made = await open(page);
  await openWorker(page, made.asking);
  expect(await isHeld(page, made, made.asking)).toBe(false);

  await page.getByTestId("worker-take-over").click();
  await expect(page.getByTestId("worker-hold")).toContainText("You hold it");
  await expect(page.getByTestId("worker-take-over")).toHaveCount(0);
  expect(await isHeld(page, made, made.asking)).toBe(true);
  // Nothing was sent to it: its composer is untouched and no message of the user's appeared.
  await expect(composerOf(page, made.asking)).toHaveValue("");

  await page.getByTestId("worker-hand-back").click();
  await expect(page.getByTestId("worker-take-over")).toBeVisible();
  expect(await isHeld(page, made, made.asking)).toBe(false);
});

test("a worker whose worktree was cleaned up stays readable, and Ask about it only fills the composer", async ({
  page,
}) => {
  const made = await open(page);
  await openList(page);
  const closed = row(page, made.cleanedUp);
  await expect(closed).toHaveAttribute("data-glyph", "merged");
  await closed.click();

  const view = page.getByTestId("finished-worker");
  await expect(view).toBeVisible();
  await expect(page.getByTestId("finished-note")).toContainText("read-only");
  await expect(page.getByTestId("finished-brief")).toContainText("dead_letters table");
  await expect(page.getByTestId("finished-facts")).toContainText("api#428");
  await expect(page.getByTestId("finished-report")).toContainText("Merged as #428");
  await expect(page.getByTestId("finished-files")).toContainText("migrations/0042_dead_letters.py");
  await expect(view).toContainText("Opened example/api#428");
  // Read-only: no composer, and the messages offer Copy but nothing that acts on the thread.
  await expect(view.getByLabel("Message", { exact: true })).toHaveCount(0);

  await page.getByTestId("finished-ask").click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  const composer = composerOf(page, made.orchestratorThreadId);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(
    new RegExp(`About the finished worker "Dead-letter table" \\[thread ${made.cleanedUp}\\]`),
  );
});

test("Why is it stuck? shows the helper's sentence and a nudge only fills the composer", async ({
  page,
}) => {
  const made = await open(page);
  await openWorker(page, made.stuck);
  const card = page.getByTestId("worker-stuck");
  await expect(card).toHaveAttribute("data-source", "helper");
  await expect(card).toContainText("idle 2 h");
  await expect(page.getByTestId("stuck-text")).toHaveText(MOCK_STUCK_TEXT);

  await page.getByTestId("stuck-nudge-checkCi").click();
  const composer = composerOf(page, made.stuck);
  await expect(composer).toHaveValue("Check CI on your PR and fix what fails.");
  await expect(composer).toBeFocused();
  // Filled, not sent: the worker is still the orchestrator's.
  expect(await isHeld(page, made, made.stuck)).toBe(false);

  await page.getByTestId("stuck-nudge-askOrchestrator").click();
  await expect(composerOf(page, made.orchestratorThreadId)).toHaveValue(
    new RegExp(`\\[thread ${made.stuck}\\] is idle 2 h`),
  );
  expect(await isHeld(page, made, made.stuck)).toBe(false);
});

test("Snooze 1 day keeps Why is it stuck? away from that worker", async ({ page }) => {
  const made = await open(page);
  await openWorker(page, made.stuck);
  await expect(page.getByTestId("worker-stuck")).toBeVisible();
  await page.getByTestId("stuck-snooze").click();
  await expect(page.getByTestId("worker-stuck")).toHaveCount(0);
  // Snoozing sends nothing and leaves the worker the orchestrator's.
  await expect(composerOf(page, made.stuck)).toHaveValue("");
  expect(await isHeld(page, made, made.stuck)).toBe(false);
  // Kept on this machine for a day, not just while the view is open.
  const until = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem("gram.stuckSnooze") ?? "{}").state?.until?.[id],
    made.stuck,
  );
  expect(until - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
});

test("Why is it stuck? with helpers off shows the facts it stands on", async ({ page }) => {
  const made = await open(page, { stuck: false });
  await openWorker(page, made.stuck);
  const card = page.getByTestId("worker-stuck");
  await expect(card).toHaveAttribute("data-source", "facts");
  await expect(page.getByTestId("stuck-facts")).toContainText(
    "Reported progress: Waiting on the paging API",
  );
  await expect(page.getByTestId("stuck-facts")).toContainText("web#91 open, checks failing");
  await expect(page.getByTestId("stuck-text")).toHaveCount(0);
});
