import { expect, test, type Page } from "@playwright/test";

import { MENU_CAP } from "../src/palette/menu-caps";
import { seedTheme } from "./seed-theme";
import { pressFirstWorkspaceKey } from "./thread-row";

// The One thread proof: on one workspace with live cards, asks and done workers,
// the orchestrator's home stays under 150 words, no menu on it goes over 7 items, an ask takes one
// key, and a worker opens in two steps or fewer. Mock state lives in memory, so every step after
// the seed stays inside the app.

/** Past the stack's settle time (`SETTLE_MS`), so a key isn't taken for a slip. */
const SETTLED_MS = 400;
const HOME_WORDS = 150;

const start = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  // The way home: the workspace's ⌘1.
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.getByTestId("ask-stack")).toBeVisible();
  await expect(page.getByTestId("feature-card").first()).toBeVisible();
  return made;
};

/** Focus on nothing, and past the settle time. */
const settle = async (page: Page) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(SETTLED_MS);
};

/**
 * The words a reader sees in `selector`'s box: visible text inside the window, marks not counted,
 * nor anything inside `except`.
 */
const visibleWords = (page: Page, selector: string, except?: string) =>
  page.evaluate(
    ([root, skip]) => {
      const box = document.querySelector(root!);
      if (box === null) return -1;
      const words: string[] = [];
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const element = node.parentElement!;
        if (element.closest("[aria-hidden=true], [inert]")) continue;
        if (skip !== undefined && element.closest(skip)) continue;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width < 2 || rect.height < 2 || style.visibility === "hidden") continue;
        if (
          rect.bottom <= 0 ||
          rect.top >= innerHeight ||
          rect.right <= 0 ||
          rect.left >= innerWidth
        )
          continue;
        words.push(...(node.textContent ?? "").split(/\s+/));
      }
      return words.filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
    },
    [selector, except] as const,
  );

const askCount = async (page: Page) =>
  Number((await page.getByTestId("ask-stack").textContent())?.match(/(\d+)\s*asks?/)?.[1]);

test("the orchestrator's home stays under 150 words", async ({ page }) => {
  await start(page);
  await settle(page);
  // Home is the orchestrator's pane: its live cards, events, the ask stack and the composer. The
  // title bar, a side panel the user keeps open and the overview sidebar down the window's left,
  // which the user can hide, are the window's, not the home's: the overview's words are the
  // workspaces, its workers' titles and the cards' now lines, held to their own limit below. Its
  // two digests, back to back, are one quiet line, collapsed, inside the budget.
  const digests = page.getByTestId("digest-line");
  await expect(digests).toHaveCount(1);
  await expect(digests.getByTestId("digest-line-toggle")).toHaveAccessibleName(/^2 digests, /);
  await expect(digests.getByTestId("digest-line-toggle")).toHaveAttribute("aria-expanded", "false");
  const words = await visibleWords(page, "[data-pane-root]", '[data-testid="overview-sidebar"]');
  expect(words).toBeGreaterThan(40);
  expect(words).toBeLessThan(HOME_WORDS);
  // The overview: at most four words of now line a worker.
  await expect(page.getByTestId("overview-sidebar")).toBeVisible();
  const nows = await page.getByTestId("overview-worker-now").allTextContents();
  expect(nows.length).toBeGreaterThan(0);
  for (const now of nows) {
    expect(now.trim().split(/\s+/).length, now).toBeLessThanOrEqual(4);
  }
});

test("no menu on the home goes over 7 items", async ({ page }) => {
  await start(page);
  const triggers = page.locator('[aria-haspopup="menu"]:visible');
  const count = await triggers.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const trigger = triggers.nth(i);
    const name = (await trigger.getAttribute("aria-label")) ?? (await trigger.textContent());
    await trigger.click();
    const menu = page.getByRole("menu").last();
    await expect(menu, `${name}'s menu`).toBeVisible();
    const items = await menu.getByRole("menuitem").allTextContents();
    // At most seven before a final More…, which opens ⌘K on the rest.
    const shown = items.filter((item) => item.trim() !== "More…");
    expect(shown.length, `${name}: ${items.join(", ")}`).toBeLessThanOrEqual(MENU_CAP);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  }
});

test("an ask takes one key", async ({ page }) => {
  await start(page);
  const before = await askCount(page);
  expect(before).toBeGreaterThan(1);
  await settle(page);
  await page.keyboard.press("Enter");
  await expect.poll(() => askCount(page)).toBe(before - 1);
});

test("a feature-card worker opens in two steps or fewer", async ({ page }) => {
  await seedTheme(page, { palette: "neutral-dark", mode: "dark", motion: "off" });
  const made = await start(page);
  const link = page.getByTestId("feature-card").getByTestId("worker-link").first();
  const href = await link.getAttribute("href");
  await link.click();
  const peek = page.getByTestId("peek-sheet");
  await expect(peek).toBeVisible();
  await peek.getByTestId("peek-open").click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await page.keyboard.press("ControlOrMeta+1");
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
});

// Each worker is an independent two-click journey. The former single case navigated through
// every worker under one 30 s budget (timing out at visit 16 on CI). Keep every visit, split
// across bounded cases, and capture ids before navigation so a reordered list cannot skip one.
const WORKER_GROUPS = 4;
for (let group = 0; group < WORKER_GROUPS; group++) {
  test(`the title bar opens every worker in two steps, group ${group + 1}/${WORKER_GROUPS}`, async ({
    page,
  }) => {
    await seedTheme(page, { palette: "neutral-dark", mode: "dark", motion: "off" });
    await page.clock.setFixedTime(new Date("2026-06-15T12:00:00Z"));
    const made = await start(page);
    const button = page.getByTestId("workers-button");
    await expect(button).toHaveAccessibleName(/^Workers, \d+ now$/);
    await button.click();
    const list = page.getByTestId("workers-list");
    await expect(list).toBeVisible();
    const ids = await page.evaluate(async (workspaceId) => {
      const mock = window.gramMock!;
      const [ledger, finished] = await Promise.all([
        mock.orchestratorLedger(workspaceId),
        mock.finishedWorkers(workspaceId),
      ]);
      return [
        ...new Set([
          ...ledger.features.flatMap((feature) => feature.workers.map((worker) => worker.threadId)),
          ...finished.map((worker) => worker.threadId),
        ]),
      ].toSorted();
    }, made.workspaceId);
    expect(ids.length).toBeGreaterThan(3);
    // The popup can mount before its queries have hydrated. Wait for the entire fixture's
    // inventory, rather than partitioning a transient subset of rows on a loaded renderer.
    await expect
      .poll(() =>
        list
          .getByRole("option")
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-thread-id")).toSorted()),
      )
      .toEqual(ids);
    const selected = ids.filter((_, index) => index % WORKER_GROUPS === group);
    expect(selected.length).toBeGreaterThan(0);
    await test.info().attach("workers-visited", {
      body: JSON.stringify({ all: ids, selected }),
      contentType: "application/json",
    });
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    for (const id of selected) {
      await button.click();
      const row = list.getByRole("option").and(list.locator(`[data-thread-id="${id}"]`));
      await row.click();
      await expect(list).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/t/${id}$`));
      await page.keyboard.press("ControlOrMeta+1");
      await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
    }
  });
}
