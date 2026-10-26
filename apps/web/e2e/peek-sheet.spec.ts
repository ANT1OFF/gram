import { expect, test, type Page } from "@playwright/test";

import type { MockOneThreadSimulation } from "../src/api/mock-asks";
import { pressFirstWorkspaceKey } from "./thread-row";

// The peek sheet: a worker's name
// or a PR chip on a live card opens a sheet over the orchestrator's pane, Esc closes it and gives
// focus back, and the full view is one more step. Peeking sends nothing and never holds a worker.
// Mock state lives in memory, so every step after the seed stays inside the app.

const start = async (page: Page): Promise<MockOneThreadSimulation> => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.getByTestId("feature-card").first()).toBeVisible();
  return made;
};

const sheet = (page: Page) => page.getByTestId("peek-sheet");

const workerName = (page: Page, threadId: string) =>
  page.getByTestId("feature-card").locator(`a[data-testid="worker-link"][href$="/t/${threadId}"]`);

/** Whether the orchestrator can't message it, and how many messages it has. */
const workerFacts = (page: Page, made: MockOneThreadSimulation, threadId: string) =>
  page.evaluate(
    async ({ workspaceId, worker }) => {
      const mock = window.gramMock!;
      const ledger = await mock.orchestratorLedger(workspaceId);
      const entry = ledger.features
        .flatMap((feature) => feature.workers)
        .find((each) => each.threadId === worker);
      return { held: entry?.userIntervened, messages: mock.world.messages(worker as never).length };
    },
    { workspaceId: made.workspaceId, worker: threadId },
  );

test("a worker's name peeks at it; Esc closes and ⏎ opens it, and peeking never holds it", async ({
  page,
}) => {
  const made = await start(page);
  const before = await workerFacts(page, made, made.live);
  expect(before.held).toBe(false);

  const name = workerName(page, made.live);
  await name.click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toHaveAttribute("data-kind", "worker");
  // Over the orchestrator, which stays where it was.
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.getByTestId("thread-view").getByTestId("peek-sheet")).toBeVisible();
  await expect(sheet(page).getByTestId("peek-title")).toHaveText("Retry with backoff · api");
  await expect(sheet(page).getByTestId("peek-brief")).toContainText(
    "Retry on 5xx with backoff; dead-letter after 5 tries.",
  );
  await expect(sheet(page).getByTestId("peek-files")).toContainText("queue/consumer.py");
  await expect(sheet(page).getByTestId("peek-command")).toHaveText(/uv run pytest tests\/queue/);
  await expect(sheet(page).getByTestId("peek-command")).toHaveAttribute("data-running", "true");
  await expect(sheet(page).getByTestId("peek-report")).toHaveText(
    "Backoff is in; 38 of 52 tests pass so far.",
  );
  await expect(sheet(page)).toContainText("A peek. Open it to see the full transcript");

  // Looking sent nothing and holds nothing.
  expect(await workerFacts(page, made, made.live)).toEqual(before);

  // Esc closes it and gives focus back to the name.
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(name).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  expect(await workerFacts(page, made, made.live)).toEqual(before);

  // ⏎ opens the full view, from Open, where the sheet puts focus.
  await name.click();
  await expect(sheet(page).getByTestId("peek-open")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/t/${made.live}$`));
  await expect(sheet(page)).toBeHidden();
  expect((await workerFacts(page, made, made.live)).held).toBe(false);
});

test("⌘-click and a middle click on a worker's name go straight to its full view", async ({
  page,
}) => {
  const made = await start(page);
  await workerName(page, made.live).click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(new RegExp(`/t/${made.live}$`));
  await expect(sheet(page)).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+1");
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await workerName(page, made.asking).click({ button: "middle" });
  await expect(page).toHaveURL(new RegExp(`/t/${made.asking}$`));
  await expect(sheet(page)).toHaveCount(0);
});

test("a PR chip peeks at the PR with what Gram knows of it, and Diff opens its worker", async ({
  page,
}) => {
  const made = await start(page);
  const chip = page
    .getByTestId("feature-card")
    .getByTestId("pr-chip")
    .filter({ hasText: /^api#212$/ });
  await chip.click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toHaveAttribute("data-kind", "pr");
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(sheet(page).getByTestId("peek-title")).toHaveText("api#212");
  await expect(sheet(page).getByTestId("peek-pr-checks")).toHaveText("Passing");
  await expect(sheet(page).getByTestId("peek-pr-review")).toHaveText(
    "Waiting on an approving review",
  );
  await expect(sheet(page).getByTestId("peek-pr-waits")).toHaveText("web#88");
  // The mock has no detail for this PR: no change line or check list rather than invented ones.
  await expect(sheet(page).getByTestId("peek-pr-change")).toHaveCount(0);
  await expect(sheet(page).getByTestId("peek-pr-runs")).toHaveCount(0);
  await expect(sheet(page).getByTestId("peek-pr-github")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(chip).toBeFocused();

  await chip.click();
  await sheet(page).getByTestId("peek-pr-diff").click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.inReview}$`));
  await expect(sheet(page)).toBeHidden();
});
