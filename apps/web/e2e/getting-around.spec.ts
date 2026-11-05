import { expect, test, type Page } from "@playwright/test";

import { openOrchestrator, threadRow } from "./thread-row";

// Getting around: Esc from a worker to its orchestrator,
// ⌘[ and ⌘] through the window's history, and the Board's ask keys right after picking it. Mock
// state lives in the page, so every step navigates inside the app rather than reloading.

/** Past the ask stack's settle window, so a key isn't taken as a slip. */
const SETTLED_MS = 350;

const url = (threadId: string) => new RegExp(`/t/${threadId}$`);

/**
 * The workers scenario, opened on one worker from ⌘J's Workers list, its orchestrator one step
 * before.
 */
const openWorker = async (page: Page) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(() => window.gramMock!.simulateWorkers());
  await openOrchestrator(page, made.orchestratorThreadId);
  await page.keyboard.press("ControlOrMeta+KeyJ");
  const list = page.getByTestId("workers-list");
  await expect(list).toBeVisible();
  await list.locator(`[data-testid="worker-row"][data-thread-id="${made.asking}"]`).click();
  await expect(page).toHaveURL(url(made.asking));
  await expect(page.getByTestId("worker-crumbs")).toBeVisible();
  return made;
};

/** Focus on nothing that types, as after a click on the transcript. */
const blur = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

const composer = (page: Page) => page.locator('[data-pane-root] textarea[aria-label="Message"]');

test("Esc goes back from a worker to its orchestrator, and ⌘[ ⌘] walk the history", async ({
  page,
}) => {
  const made = await openWorker(page);
  await blur(page);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(url(made.orchestratorThreadId));
  // The orchestrator is home: Esc there goes nowhere.
  await blur(page);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(url(made.orchestratorThreadId));

  await page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect(page).toHaveURL(url(made.asking));
  await page.keyboard.press("ControlOrMeta+BracketRight");
  await expect(page).toHaveURL(url(made.orchestratorThreadId));
  await page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect(page).toHaveURL(url(made.asking));
});

test("Esc on a worker never takes a menu's, a field's or an approval's Esc", async ({ page }) => {
  const made = await openWorker(page);

  // An open menu closes, and that is all.
  await page.getByRole("button", { name: "Thread menu" }).first().click();
  await expect(page.getByTestId("thread-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("thread-menu")).toBeHidden();
  await expect(page).toHaveURL(url(made.asking));

  // The composer keeps Esc, with a draft or without one.
  await composer(page).focus();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(url(made.asking));
  await composer(page).fill("half a thought");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(url(made.asking));
  await expect(composer(page)).toHaveValue("half a thought");

  // ⌘[ in a field is the field's too.
  await page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect(page).toHaveURL(url(made.asking));
});

test("a worker with an approval waiting keeps Esc for Deny", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(() => window.gramMock!.simulateAsks());
  const pusher = made.pushers[0];
  // The pusher's row is under its workspace, which opens on its orchestrator.
  await openOrchestrator(page, made.orchestratorThreadId);
  await threadRow(page, pusher).click();
  await expect(page).toHaveURL(url(pusher));
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await blur(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("approval-card")).toBeHidden();
  await expect(page).toHaveURL(url(pusher));
});

/** The asks scenario on its orchestrator, in Chat. */
const openAsks = async (page: Page) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(() => window.gramMock!.simulateAsks());
  await openOrchestrator(page, made.orchestratorThreadId);
  return made;
};

/** The first keys after picking Board reach the window: ⌘⇧I opens the Inbox, and j moves in it. */
const arrowSteps = async (page: Page) => {
  await page.waitForTimeout(SETTLED_MS);
  await page.keyboard.press("ControlOrMeta+Shift+I");
  const detail = page.getByTestId("inbox-detail");
  await expect(detail).toBeVisible();
  const first = await detail.getAttribute("data-key");
  await page.keyboard.press("j");
  await expect(detail).not.toHaveAttribute("data-key", first!);
};

test("Keys reach the Inbox right after a click on Board", async ({ page }) => {
  await openAsks(page);
  await page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  await expect(page.getByTestId("rail-board")).toBeFocused();
  await arrowSteps(page);
});

test("Keys reach the Inbox right after ⌘⌥2 from the composer", async ({ page }) => {
  await openAsks(page);
  await composer(page).focus();
  await page.keyboard.press("ControlOrMeta+Alt+Digit2");
  await expect(page.getByTestId("rail-board")).toBeFocused();
  await arrowSteps(page);
});

const viewRadio = (page: Page, name: string) =>
  page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: new RegExp(`^${name}\\b`) });

test("Keys reach the Inbox right after picking it with the switcher's arrows", async ({ page }) => {
  await openAsks(page);
  await viewRadio(page, "Chat").focus();
  await page.keyboard.press("ArrowRight");
  await expect(viewRadio(page, "Board")).toBeChecked();
  await expect(page.getByTestId("rail-board")).toBeFocused();
  await arrowSteps(page);
});

test("Keys reach the Inbox after clicking Board again while it shows", async ({ page }) => {
  await openAsks(page);
  await viewRadio(page, "Board").click();
  await expect(page.getByTestId("rail-board")).toBeFocused();
  // Board is already showing: this click mounts nothing, and focus used to stay on the radio.
  await viewRadio(page, "Board").click();
  await expect(page.getByTestId("rail-board")).toBeFocused();
  await arrowSteps(page);
});

test("picking Board again never takes focus from a field being typed in", async ({ page }) => {
  await openAsks(page);
  await viewRadio(page, "Board").click();
  await page.getByTestId("rail-waiting-chip").click();
  await page.getByTestId("inbox-item").filter({ hasText: "registry page" }).click();
  const reply = page.getByTestId("inbox-detail").getByTestId("ask-reply-input");
  await reply.fill("No packages yet");
  await page.keyboard.press("ControlOrMeta+Alt+Digit2");
  await expect(reply).toBeFocused();
  await page.keyboard.type(", thanks");
  await expect(reply).toHaveValue("No packages yet, thanks");
});
