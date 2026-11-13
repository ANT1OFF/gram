import { expect, test, type Page } from "@playwright/test";
import { openPanelTab } from "./panel-tab";
import { openOrchestrator, threadRow } from "./thread-row";

// Where a thread runs when that isn't this machine, wherever the thread is listed. Synthetic
// machines, as the server sends them on its event stream: no host, tailnet or account behind them.

const ATLAS = "m-0123456789abcdef01234567";
const STUDIO = "m-89abcdef0123456701234567";
const SANDBOX = "m-456789abcdef012301234567";

const machines = (atlasOnline = true) => [
  atlasOnline
    ? { id: ATLAS, name: "atlas", kind: "joined", onlineSince: 1 }
    : { id: ATLAS, name: "atlas", kind: "joined", offline: { kind: "never" } },
  { id: STUDIO, name: "studio", kind: "joined", offline: { kind: "never" } },
  { id: SANDBOX, name: "sandbox-1", kind: "provisioned", onlineSince: 1 },
];

/** The board workspace, with a worker on each machine and the rest on this one. */
const start = async (page: Page) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(() => window.gramMock!.simulateOrchestration("board"));
  await openOrchestrator(page, made.orchestratorThreadId);
  await expect(threadRow(page, made.working)).toBeVisible();
  await page.evaluate(
    ({ ids, list, hosts }) => {
      const mock = window.gramMock!;
      mock.setMachines(list as never);
      mock.placeOnMachine(ids.working, hosts.atlas);
      mock.placeOnMachine(ids.inReview, hosts.studio);
      mock.placeOnMachine(ids.ungrouped, hosts.sandbox);
      mock.placeOnMachine("t-flaky" as never, hosts.atlas);
    },
    { ids: made, list: machines(), hosts: { atlas: ATLAS, studio: STUDIO, sandbox: SANDBOX } },
  );
  return made;
};

test("the sidebar names the machine a thread runs on, and nothing for one on this machine", async ({
  page,
}) => {
  const made = await start(page);

  // At work, its edge is otherwise empty: the machine's name stands there.
  const working = threadRow(page, made.working).getByTestId("overview-worker-machine");
  await expect(working).toHaveText("atlas");
  await expect(working).toHaveAttribute("data-machine-state", "online");
  await expect(threadRow(page, made.working)).toHaveAccessibleName(/on atlas/);

  // On this machine: no marker at all.
  await expect(threadRow(page, made.briefed).getByTestId("overview-worker-machine")).toHaveCount(0);

  // An offline machine shows without a hover, whatever else the row says.
  await expect(
    threadRow(page, made.inReview).getByTestId("overview-worker-machine"),
  ).toHaveAttribute("data-machine-state", "offline");

  // A solo thread names it before its time.
  const solo = threadRow(page, "t-flaky").getByTestId("overview-solo-machine");
  await expect(solo).toHaveText("atlas");

  // Its hover card says the machine, how it got in and its state.
  await threadRow(page, made.working).hover();
  await expect(page.getByTestId("overview-worker-card-machine")).toContainText(
    "Runs on atlas\nJoined machine · online",
  );

  // Opened, its header says the machine and the folder there.
  await threadRow(page, made.working).click();
  const chip = page.getByTestId("pane-machine").first();
  await expect(chip).toContainText("atlas");
  await expect(chip).toHaveAttribute("data-machine-state", "online");
  await expect(chip).toHaveAttribute("aria-label", /^Runs on atlas in \//);
});

test("a machine that drops shows offline at once, with no reload", async ({ page }) => {
  const made = await start(page);
  const marker = threadRow(page, made.working).getByTestId("overview-worker-machine");
  await expect(marker).toHaveText("atlas");

  await page.evaluate((list) => window.gramMock!.setMachines(list as never), machines(false));
  await expect(marker).toHaveAttribute("data-machine-state", "offline");
  await expect(marker).toHaveText("atlasoffline");
  await expect(threadRow(page, "t-flaky").getByTestId("overview-solo-machine")).toHaveText(
    "atlasoffline",
  );
});

test("the Board and the Workers tab name the machine too", async ({ page }) => {
  const made = await start(page);

  await openPanelTab(page.getByTestId("right-panel"), "Workers");
  const row = page.locator(`[data-testid="workers-panel-row"][data-thread-id="${made.working}"]`);
  await expect(row.getByTestId("workers-panel-machine")).toHaveText("atlas");
  await expect(row.getByTestId("workers-panel-machine")).toHaveAttribute(
    "title",
    /^Runs on atlas\nJoined machine · online/,
  );
  const offline = page.locator(
    `[data-testid="workers-panel-row"][data-thread-id="${made.inReview}"]`,
  );
  await expect(offline.getByTestId("workers-panel-machine")).toHaveText("studiooffline");

  await page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  const board = page.getByTestId("rail-board");
  await expect(board.getByTestId("rail-machine").filter({ hasText: "sandbox-1" })).toBeVisible();
  await expect(board.getByTestId("rail-machine").filter({ hasText: "studio" })).toHaveAttribute(
    "data-machine-state",
    "offline",
  );
});
