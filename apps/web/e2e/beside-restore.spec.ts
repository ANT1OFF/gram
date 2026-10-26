import { expect, test, type Page } from "@playwright/test";

import type { MockReachingSimulation } from "../src/api/mock-reaching";
import { openOrchestrator, threadRow } from "./thread-row";

// Restore uses a full document load and the compiled store's real persistence hydration.
// The test's mock server world is recreated before its initial snapshot when requested;
// the missing-worker case deliberately reloads without recreating that world.
declare global {
  interface Window {
    gramRestoredBesideWorkers?: MockReachingSimulation;
  }
}

interface StoredDock {
  readonly worker?: string;
  readonly last?: string;
  readonly tab?: string;
}

const open = async (page: Page): Promise<MockReachingSimulation> => {
  await page.goto("/");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(() => window.gramMock!.simulateReachingWorkers());
  await openOrchestrator(page, made.orchestratorThreadId);
  return made;
};

/** This tab's dock as saved: under `gram.beside.<window id>` in its session storage. */
const storedDock = (page: Page) =>
  page.evaluate(() => {
    const self = JSON.parse(sessionStorage.getItem("gram.window") ?? "{}") as { id?: string };
    const saved = sessionStorage.getItem(`gram.beside.${self.id}`);
    return saved === null ? undefined : (JSON.parse(saved) as { state: StoredDock }).state;
  });

/** Install before navigation; each recreated mock instance seeds once, before any snapshot. */
const retainMockWorkersOnReload = (page: Page) =>
  page.addInitScript(() => {
    if (sessionStorage.getItem("gram.test.restoreBesideWorkers") !== "1") return;
    sessionStorage.removeItem("gram.test.restoreBesideWorkers");
    Object.defineProperty(window, "gramMock", {
      configurable: true,
      set(mock: NonNullable<typeof window.gramMock>) {
        const events = mock.events.bind(mock);
        const seeded = mock.simulateReachingWorkers();
        mock.events = async function* (...args) {
          window.gramRestoredBesideWorkers = await seeded;
          yield* events(...args);
        };
        Object.defineProperty(window, "gramMock", {
          configurable: true,
          writable: true,
          value: mock,
        });
      },
    });
  });

/** Save the original payload, then let a new document hydrate the actual store. */
const reloadDock = async (page: Page, dock: StoredDock, original: MockReachingSimulation) => {
  await page.evaluate((saved) => {
    const self = JSON.parse(sessionStorage.getItem("gram.window") ?? "{}") as { id?: string };
    sessionStorage.setItem(`gram.beside.${self.id}`, JSON.stringify({ state: saved, version: 1 }));
    sessionStorage.setItem("gram.test.restoreBesideWorkers", "1");
  }, dock);
  await page.goto(page.url());
  await expect
    .poll(() =>
      page.evaluate(() => {
        const made = window.gramRestoredBesideWorkers;
        return made && { orchestratorThreadId: made.orchestratorThreadId, live: made.live };
      }),
    )
    .toEqual({ orchestratorThreadId: original.orchestratorThreadId, live: original.live });
};

test("a docked worker comes back on its tab beside the orchestrator in view", async ({ page }) => {
  await retainMockWorkersOnReload(page);
  const made = await open(page);
  await threadRow(page, made.live).click();
  // ⌘\ keeps the focused worker beside: once its pane is the one in view.
  await expect(page.locator(`[data-testid="pane"][data-thread-id="${made.live}"]`)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Backslash");
  const dock = page.getByTestId("beside-dock");
  await expect(dock).toHaveAttribute("data-thread-id", made.live);
  await dock.getByTestId("beside-tab-changes").click();
  const saved = await storedDock(page);
  expect(saved).toEqual({ worker: made.live, last: made.live, tab: "changes" });

  await reloadDock(page, { ...saved }, made);
  await expect(dock).toHaveAttribute("data-thread-id", made.live);
  await expect(dock.getByTestId("beside-tab-changes")).toHaveAttribute("aria-selected", "true");

  // Another thread in view: the saved dock is dropped, and forgotten.
  await threadRow(page, "t-flaky").click();
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
  await reloadDock(page, { ...saved }, made);
  await expect(dock).toHaveCount(0);
  await expect.poll(async () => (await storedDock(page))?.worker).toBeUndefined();

  // A thread that isn't a worker of the orchestrator is never docked from storage.
  await openOrchestrator(page, made.orchestratorThreadId);
  await reloadDock(page, { worker: "t-flaky", tab: "log" }, made);
  await expect(dock).toHaveCount(0);
  await expect.poll(async () => (await storedDock(page))?.worker).toBeUndefined();
});

test("a real reload reads the saved dock and drops it once its worker is gone", async ({
  page,
}) => {
  const made = await open(page);
  await threadRow(page, made.live).click();
  // ⌘\ keeps the focused worker beside: once its pane is the one in view.
  await expect(page.locator(`[data-testid="pane"][data-thread-id="${made.live}"]`)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(page.getByTestId("beside-dock")).toHaveAttribute("data-thread-id", made.live);
  await expect.poll(async () => (await storedDock(page))?.worker).toBe(made.live);

  // The mock forgets its simulated threads on reload, so the docked worker no longer exists.
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  await expect(page.getByTestId("beside-dock")).toHaveCount(0);
  await expect.poll(async () => (await storedDock(page))?.worker).toBeUndefined();
  expect((await storedDock(page))?.last).toBe(made.live);
  expect(await page.evaluate(() => window.gramRestoredBesideWorkers)).toBeUndefined();
});
