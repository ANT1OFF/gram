import { expect, test, type Page } from "@playwright/test";

import { MOCK_STUCK_TEXT, type MockReachingSimulation } from "../src/api/mock-reaching";
import { openOrchestrator, threadRow } from "./thread-row";
import { openPanelTab } from "./panel-tab";

// Reaching workers beyond ⌘J: opening one beside the chat (⌘\), Take over, a worker whose worktree
// was cleaned up, and "Why is it stuck?". None of the ways to look at a worker holds it, and nothing
// here sends a message but the one typed into a worker beside the chat, which is the user's own.

const MOCK_SETTINGS_KEY = "gram.mock.settings";

const withSettings = (page: Page, settings: object) =>
  page.addInitScript(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
    key: MOCK_SETTINGS_KEY,
    value: settings,
  });

const open = async (page: Page, helpers: object = {}): Promise<MockReachingSimulation> => {
  await withSettings(page, { helpers });
  // Wide enough that the title bar keeps Workers, Open beside and Take over out of its folded "…".
  await page.setViewportSize({ width: 1680, height: 900 });
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  // Beside the Files tab: a review opens wider and leaves the chat, and its title bar, 800 px.
  await openPanelTab(page.getByTestId("right-panel"), "Files");
  const made = await page.evaluate(() => window.gramMock!.simulateReachingWorkers());
  await openOrchestrator(page, made.orchestratorThreadId);
  return made;
};

const list = (page: Page) => page.getByTestId("workers-panel");
const row = (page: Page, threadId: string) =>
  list(page).locator(`[data-testid="workers-panel-row"][data-thread-id="${threadId}"]`);
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

/** The right panel's Workers tab, from Workers in the title bar's "…". */
const openList = async (page: Page) => {
  await page.getByTestId("shell-titlebar").getByTestId("titlebar-overflow").click();
  await page.getByTestId("folded-workers").click();
  await expect(list(page)).toBeVisible();
};

const openWorker = async (page: Page, threadId: string) => {
  await openList(page);
  // ⌘-click: in the main view, not beside the chat.
  await row(page, threadId).click({ modifiers: ["ControlOrMeta"] });
  await expect(pane(page, threadId)).toBeVisible();
};

test("⌘\\ opens a worker beside the chat without holding it or taking typing", async ({ page }) => {
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
  // It sits in the right panel's Thread tab, on the worker's conversation, with the worker's own
  // composer; its last command and its changes are a view away. None of it takes the typing.
  await expect(
    page.getByTestId("right-panel").getByRole("tab", { name: "Thread", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(dock.getByTestId("beside-tab-thread")).toHaveAttribute("aria-selected", "true");
  await expect(dock.getByTestId("transcript")).toBeVisible();
  await expect(dock.getByLabel("Message", { exact: true })).toHaveAttribute(
    "placeholder",
    "Steer this thread…",
  );
  await dock.getByTestId("beside-tab-terminal").click();
  await expect(composer).toHaveValue("Tell me when it's green");
  await dock.getByTestId("beside-tab-thread").click();
  await expect(composer).toBeFocused();
  expect(await isHeld(page, made, made.live)).toBe(false);

  // ⌘\ again closes it; from the orchestrator it brings the same worker back; Close closes it too.
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(dock).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(dock).toHaveAttribute("data-thread-id", made.live);
  await dock.getByTestId("beside-close").click();
  await expect(dock).toHaveCount(0);

  // A worker's row in the Workers tab opens it beside the chat.
  await openList(page);
  await row(page, made.asking).click();
  await expect(dock).toHaveAttribute("data-thread-id", made.asking);
  expect(await isHeld(page, made, made.live)).toBe(false);
  expect(await isHeld(page, made, made.asking)).toBe(false);
});

/** A plain approval for a Bash command, as a test raises one. */
const approval = (id: string, command: string) => ({
  kind: "approval" as const,
  id,
  toolName: "Bash",
  displayName: "Bash",
  input: { command },
  suggestions: [],
});

test("an approval answered beside the chat hands focus on in its own thread, and one in the chat in the chat's", async ({
  page,
}) => {
  const made = await open(page);
  await openWorker(page, made.live);
  await page.keyboard.press("ControlOrMeta+Backslash");
  const dock = page.getByTestId("beside-dock");
  await expect(dock).toHaveAttribute("data-thread-id", made.live);
  // Two approvals wait in the chat (the orchestrator's) and one in the worker beside it.
  const asks = [
    [made.orchestratorThreadId, approval("chat-1", "echo chat one")],
    [made.orchestratorThreadId, approval("chat-2", "echo chat two")],
    [made.live, approval("beside-1", "echo beside")],
  ] as const;
  await page.evaluate((each) => {
    for (const [threadId, request] of each) {
      window.gramMock!.simulateRequest(threadId as never, request as never);
    }
  }, asks);
  const chat = page.locator(`[data-thread-view="${made.orchestratorThreadId}"]`).first();
  const beside = dock.locator(`[data-thread-view="${made.live}"]`);
  const card = (id: string) =>
    page.locator(`[data-testid="approval-card"][data-request-id="${id}"]`);
  await expect(card("chat-1")).toBeVisible();
  await expect(card("beside-1")).toBeVisible();

  // Answered in the chat: the chat's next approval has focus, never the one beside it.
  await card("chat-1").getByTestId("approval-deny").click();
  await expect(card("chat-1")).toHaveCount(0);
  await expect(card("chat-2")).toBeFocused();
  await expect(chat.locator(":focus")).toHaveCount(1);

  // Answered beside the chat: focus goes to the worker's composer there, never to the chat's card.
  await card("beside-1").getByTestId("approval-deny").click();
  await expect(card("beside-1")).toHaveCount(0);
  await expect(beside.getByLabel("Message", { exact: true })).toBeFocused();
  await expect(card("chat-2")).not.toBeFocused();
});

test("what you send beside the chat is you typing into the worker", async ({ page }) => {
  const made = await open(page);
  await openWorker(page, made.live);
  await page.keyboard.press("ControlOrMeta+Backslash");
  const dock = page.getByTestId("beside-dock");
  await expect(dock).toHaveAttribute("data-thread-id", made.live);
  const orchestrator = composerOf(page, made.orchestratorThreadId);
  await expect(orchestrator).toBeFocused();
  expect(await isHeld(page, made, made.live)).toBe(false);

  // A click in the Thread tab gives it the keys; what is typed goes to the worker's draft alone.
  const steer = dock.getByLabel("Message", { exact: true });
  await steer.click();
  await page.keyboard.type("Use the retry helper");
  await expect(steer).toHaveValue("Use the retry helper");
  await expect(orchestrator).toHaveValue("");
  await page.keyboard.press("Enter");
  await expect(steer).toHaveValue("");
  await expect(
    dock.getByTestId("message-user").filter({ hasText: "Use the retry helper" }),
  ).toHaveCount(1);
  // The worker has it as the user's own words, and holds off its orchestrator, as in its own view.
  await expect.poll(() => isHeld(page, made, made.live)).toBe(true);
  await expect(
    pane(page, made.orchestratorThreadId)
      .getByTestId("message-user")
      .filter({ hasText: "retry helper" }),
  ).toHaveCount(0);

  // Open full view swaps the chat for the worker, and the panel's Thread tab goes.
  await dock.getByTestId("beside-open").click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.live}$`));
  await expect(dock).toHaveCount(0);
});

test("Take over holds a worker without a message, and Hand back returns it", async ({ page }) => {
  const made = await open(page);
  await openWorker(page, made.asking);
  expect(await isHeld(page, made, made.asking)).toBe(false);
  // While Take over is offered, a line under the header says what it would change.
  await expect(page.getByTestId("worker-banner-take-over")).toContainText(
    "the orchestrator stops messaging it until you hand it back",
  );
  // Shown as the line, it isn't a mark beside Take over too.
  await expect(page.getByTestId("worker-take-over-info")).toHaveCount(0);
  // Where the message is written, the composer names the worker, and with a draft Send and the
  // line beside it say that sending takes it over.
  await expect(composerOf(page, made.asking)).toHaveAttribute(
    "placeholder",
    /^(Message this worker|Queue a message for this worker)… /,
  );
  await composerOf(page, made.asking).fill("Draft only");
  await expect(
    page.getByRole("button", { name: /^(Send|Queue) and take over from the orchestrator$/ }),
  ).toBeVisible();
  await expect(page.getByText("Sending takes over from the orchestrator")).toBeVisible();
  await composerOf(page, made.asking).fill("");

  await page.getByTestId("worker-take-over").click();
  await expect(page.getByTestId("worker-hold")).toContainText("Under your control");
  await expect(page.getByTestId("worker-take-over")).toHaveCount(0);
  await expect(page.getByTestId("worker-banner-take-over")).toHaveCount(0);
  expect(await isHeld(page, made, made.asking)).toBe(true);
  // Held, a message no longer takes anything: the composer says plain Message again.
  await expect(composerOf(page, made.asking)).toHaveAttribute(
    "placeholder",
    /^(Message|Queue a message)… /,
  );
  // Nothing was sent to it: its composer is untouched and no message of the user's appeared.
  await expect(composerOf(page, made.asking)).toHaveValue("");

  await page.getByTestId("worker-hand-back").click();
  await expect(page.getByTestId("worker-take-over")).toBeVisible();
  expect(await isHeld(page, made, made.asking)).toBe(false);

  // Read once, the line folds away for good: the next worker offers Take over with no line under
  // its header, the button's hint saying what it changes.
  await openWorker(page, made.live);
  await expect(page.getByTestId("worker-take-over")).toBeVisible();
  await expect(page.getByTestId("worker-banner-take-over")).toHaveCount(0);
  // It folds to an ⓘ beside Take over, which says it on hover.
  const info = page.getByTestId("worker-take-over-info");
  await expect(info).toBeVisible();
  await info.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
    "the orchestrator stops messaging it until you hand it back",
  );
  expect(await page.evaluate(() => window.gramMock!.getSettings())).toMatchObject({
    onboarding: { takeOverHintSeen: true },
  });
});

test("a worker whose worktree was cleaned up stays readable, and Ask about it only fills the composer", async ({
  page,
}) => {
  const made = await open(page);
  // Finished workers are in History, the cleaned-up ones among them.
  await page.keyboard.press("ControlOrMeta+Shift+KeyH");
  const closed = page
    .getByTestId("history")
    .locator(`[data-testid="history-row"][data-thread-id="${made.cleanedUp}"]`);
  await expect(closed).toHaveAttribute("data-outcome", "merged");
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
