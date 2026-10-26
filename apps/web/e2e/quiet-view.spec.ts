import { expect, test, type Page } from "@playwright/test";

import { slowdown } from "./slowdown";
import { openOrchestrator, threadRow } from "./thread-row";

// Quiet: one ask card at a time over an empty field, a strip with
// a dot per worker, and the window dropping into it by itself when idle. Mock state lives in memory,
// so the seed runs first and every later step stays inside the app.

const MOCK_SETTINGS_KEY = "gram.mock.settings";
/** Past the settle time (`SETTLE_MS`), so a key isn't taken for a slip. */
const SETTLED_MS = 400;
/** The undo window (`UNDO_MS`) and then some, for an answer to have gone out. */
const SENT_MS = 8_000 * slowdown;
const PUSH = "git push -u origin feat/mail-trigger";

const seed = async (page: Page, settings: object = {}) => {
  await page.addInitScript(
    ([key, value]) => {
      if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, value);
    },
    [MOCK_SETTINGS_KEY, JSON.stringify(settings)] as const,
  );
  // Wide enough that the orchestrator's title bar keeps Quiet out of its folded "…".
  await page.setViewportSize({ width: 1680, height: 900 });
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
};

const start = async (page: Page) => {
  await seed(page);
  const made = await page.evaluate(() => window.gramMock!.simulateFailures());
  await openOrchestrator(page, made.orchestratorThreadId);
  await expect(page.getByTestId("ask-stack")).toBeVisible();
  await page.getByTestId("quiet-toggle").click();
  await expect(quiet(page)).toBeVisible();
  await expect(card(page)).toBeVisible();
  return made;
};

const quiet = (page: Page) => page.getByTestId("quiet-view");
const card = (page: Page) => quiet(page).getByTestId("quiet-card");
const position = (page: Page) => card(page).getByTestId("quiet-position");
const total = async (page: Page) =>
  Number((await position(page).textContent())?.match(/of (\d+)/)?.[1]);

/** Focus on nothing, and past the settle time. */
const settle = async (page: Page) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(SETTLED_MS);
};

/** → until the top card shows `text`. */
const goTo = async (page: Page, text: string) => {
  for (let tries = 0; tries < 12; tries++) {
    await settle(page);
    if ((await card(page).textContent())?.includes(text)) return;
    await page.keyboard.press("ArrowRight");
  }
  await expect(card(page)).toContainText(text);
};

const pending = (page: Page, threadId: string) =>
  page.evaluate(
    (id) => window.gramMock!.world.summary(id as never).pendingRequests.map((r) => r.id),
    threadId,
  );

test("one card at a time: Enter answers it everywhere, and undo brings it back", async ({
  page,
}) => {
  const made = await start(page);
  const before = await total(page);
  expect(before).toBeGreaterThan(2);
  await expect(position(page)).toHaveText(`1 of ${before}`);
  // Only one card on screen, whatever the deck holds.
  await expect(quiet(page).getByTestId("quiet-card")).toHaveCount(1);

  await goTo(page, PUSH);
  await expect(card(page).getByTestId("quiet-command")).toHaveText(PUSH);
  await page.keyboard.press("Enter");
  await expect(quiet(page).getByTestId("quiet-undo-line")).toContainText("Allowed 3");
  await expect(position(page)).toHaveText(`1 of ${before - 1}`);

  // ⌘Z takes it back while it waits, and it is in the deck again.
  await settle(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => total(page)).toBe(before);

  // Answered again, it goes out, and the orchestrator's stack doesn't show it either.
  await goTo(page, PUSH);
  await page.keyboard.press("Enter");
  for (const worker of made.pushers) {
    await expect.poll(() => pending(page, worker), { timeout: SENT_MS }).toEqual([]);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("quiet-layer")).toBeHidden();
  const stack = page.getByTestId("ask-stack");
  await stack.getByTestId("ask-expand").click();
  await expect(stack.getByTestId("ask-command").filter({ hasText: PUSH })).toHaveCount(0);
});

test("Later sends a card to the back, and O opens its thread out of Quiet", async ({ page }) => {
  await start(page);
  await settle(page);
  const first = await card(page).getAttribute("data-key");
  await page.keyboard.press("ArrowRight");
  await expect(card(page)).not.toHaveAttribute("data-key", first!);
  // Sent back, it comes round again after the rest.
  const n = await total(page);
  for (let step = 1; step < n; step++) {
    await settle(page);
    await card(page).getByTestId("quiet-later").click();
  }
  await expect(card(page)).toHaveAttribute("data-key", first!);

  await settle(page);
  await page.keyboard.press("o");
  await expect(page.getByTestId("quiet-layer")).toBeHidden();
  await expect(page).toHaveURL(/\/t\//);
});

test("the strip shows a dot per worker, and a workspace opens onto its workers", async ({
  page,
}) => {
  const made = await start(page);
  const strip = quiet(page).getByTestId("quiet-strip");
  await expect(strip.getByTestId("quiet-strip-workspace")).toHaveCount(2);
  const home = strip.locator(`[data-workspace="${made.workspaceId}"]`);
  await expect(home.getByTestId("quiet-dot").first()).toBeVisible();
  await expect(strip.getByTestId("quiet-asks")).toContainText(String(await total(page)));

  await home.click();
  const peek = quiet(page).getByTestId("quiet-peek");
  await expect(peek.getByTestId("quiet-peek-worker").first()).toBeVisible();
  await peek.getByRole("button", { name: "Talk to the orchestrator" }).click();
  await expect(page.getByTestId("quiet-layer")).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
});

test("nothing asked: the empty field says what is going on", async ({ page }) => {
  await seed(page);
  await page.getByTestId("quiet-toggle").click();
  await expect(quiet(page).getByTestId("quiet-empty")).toContainText("Nothing needs you.");
  await expect(quiet(page).getByTestId("quiet-summary")).toHaveText(/workers? (is|are) busy\./);
  await quiet(page).getByTestId("quiet-menu").click();
  // No workspaces in this seed, so nothing to pause: the menu is New task and Settings.
  await expect(page.getByTestId("quiet-menu-popup").getByRole("menuitem")).toHaveText([
    "New task",
    "Settings",
  ]);
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByTestId("quiet-layer")).toBeHidden();
  await expect(page).toHaveURL(/\/settings/);
});

test("Quiet when idle: the window goes quiet by itself, and only when on", async ({ page }) => {
  await page.clock.install();
  await seed(page, { layout: { quietWhenIdle: true } });
  await expect(page.getByTestId("quiet-layer")).toBeHidden();
  // A jump: every due timer fires once, so the idle check runs with six minutes gone.
  await page.clock.fastForward("06:00");
  await expect(page.getByTestId("quiet-layer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("quiet-layer")).toBeHidden();

  // A key now and then keeps it awake.
  for (let minute = 0; minute < 6; minute++) {
    await page.clock.fastForward("01:00");
    await page.mouse.move(10 + minute, 300);
  }
  await expect(page.getByTestId("quiet-layer")).toBeHidden();
});
