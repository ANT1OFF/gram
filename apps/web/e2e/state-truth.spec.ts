import { expect, test, type Page } from "@playwright/test";

import { openPanelTab } from "./panel-tab";
import { openOrchestrator, threadRow } from "./thread-row";

// One moment, every surface: what needs you is counted once (`needsYouIn`) and each surface reads
// its scope of that count, saying the scope when it is not the whole. Round 11 found the Workers
// panel saying "Needs you 0", the sidebar "2 need you" and Quiet "1 of 1" at the same time, and a
// worker that had just started reading "Stopped".

/** The realistic scenario's Gram orchestrator, with the right panel open. */
const openRealistic = async (page: Page) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.orchestration", "realistic");
    sessionStorage.setItem("gram.mock.settings", JSON.stringify({ panel: { open: true } }));
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  const made = await page.evaluate(async () => {
    const started = await window.gramMock!.startedRealistic();
    if (started === undefined) throw new Error("the mock did not start the realistic scenario");
    const workspaces = await window.gramMock!.listWorkspaces();
    const billing = workspaces.find((w) => w.workspace.id === started.askingWorkspaceId)!;
    return { ...started, billingOrchestrator: billing.workspace.orchestratorThreadId! };
  });
  await openOrchestrator(page, made.orchestratorThreadId);
  await expect(page.locator(`[data-thread-view="${made.orchestratorThreadId}"]`)).toBeVisible();
  return made;
};

const workspaceLine = (page: Page, workspaceId: string) =>
  page.locator(`[data-testid="overview-workspace"][data-workspace-id="${workspaceId}"]`);

/** The Workers tab of the right panel, opened. */
const workersPanel = async (page: Page) => {
  await openPanelTab(page.getByTestId("right-panel"), "Workers");
  const panel = page.getByTestId("workers-panel");
  await expect(panel).toBeVisible();
  return panel;
};

const count = async (locator: ReturnType<Page["locator"]>, attribute: string) =>
  Number(await locator.getAttribute(attribute));

test("the sidebar, the Workers panel, the Inbox and Quiet agree on what needs you", async ({
  page,
}) => {
  const made = await openRealistic(page);

  // The sidebar: the one total, and each workspace's share of it.
  const pill = page.getByTestId("overview-needs-you");
  await expect(pill).toHaveAttribute("data-count", "2");
  const total = await count(pill, "data-count");
  const shares = await Promise.all(
    made.workspaceIds.map((id) => count(workspaceLine(page, id), "data-asks")),
  );
  const gramShare = shares[made.workspaceIds.indexOf(made.workspaceId)]!;
  const billingShare = shares[made.workspaceIds.indexOf(made.askingWorkspaceId)]!;
  expect(gramShare).toBe(0);
  expect(billingShare).toBe(1);
  // The rest is the solo thread's red PR, which its own row says, not "Stopped".
  const solo = total - shares.reduce((sum, n) => sum + n, 0);
  expect(solo).toBe(1);
  const flaky = threadRow(page, "t-flaky");
  await expect(flaky.getByTestId("overview-solo-status")).toContainText("#412 checks failing");
  await expect(flaky.getByTestId("overview-solo-status")).not.toContainText("Stopped");

  // The Workers panel names its workspace, counts that workspace's share, and says the rest.
  let panel = await workersPanel(page);
  await expect(panel.getByTestId("workers-panel-title")).toHaveText("Workers in Gram");
  await expect(panel.getByTestId("workers-group-needs")).toHaveAttribute(
    "data-count",
    String(gramShare),
  );
  await expect(panel.getByTestId("workers-group-empty").first()).toHaveText(
    "Nothing in Gram needs you",
  );
  await expect(panel.getByTestId("workers-needs-elsewhere")).toHaveText(
    `${total - gramShare} need you elsewhere · Open Inbox`,
  );

  // In billing-api, its asking worker is its Needs you, the same 1 as its line's badge.
  await openOrchestrator(page, made.billingOrchestrator);
  panel = await workersPanel(page);
  await expect(panel.getByTestId("workers-panel-title")).toHaveText("Workers in billing-api");
  const needs = panel.getByTestId("workers-group-needs");
  await expect(needs).toHaveAttribute("data-count", String(billingShare));
  await expect(needs.getByTestId("workers-panel-row")).toHaveAttribute(
    "data-thread-id",
    made.asking,
  );
  await expect(panel.getByTestId("workers-needs-elsewhere")).toHaveText(
    `${total - billingShare} more needs you elsewhere · Open Inbox`,
  );

  // The Inbox lists the whole count; its link from the panel opens it.
  await panel.getByTestId("workers-needs-elsewhere").click();
  const inbox = page.getByTestId("inbox");
  await expect(inbox).toBeVisible();
  await expect(inbox.getByTestId("inbox-count")).toHaveText(`${total} need you`);
  await expect(inbox.getByTestId("inbox-item")).toHaveCount(total);
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // Quiet answers asks one card at a time and says where the rest is: the two add up to the pill.
  await page.getByTestId("titlebar-overflow").click();
  await page.getByTestId("menu-view").click();
  await page.getByTestId("folded-quiet").click();
  const quiet = page.getByTestId("quiet-view");
  await expect(quiet).toBeVisible();
  await expect(quiet.getByTestId("quiet-position")).toHaveText("1 of 1 to answer");
  await expect(quiet.getByTestId("quiet-rest")).toContainText("1 error waits in the Inbox");
  await expect(quiet.getByTestId("quiet-asks")).toHaveAttribute("data-count", String(total));
});

test("a worker spawned and not yet begun reads Starting everywhere, never Stopped", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("gram.mock.settings", JSON.stringify({ panel: { open: true } })),
  );
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  // The board scenario's registry-paging worker: briefed, its session at rest, no turn begun yet.
  const made = await page.evaluate(() => window.gramMock!.simulateOrchestration("board"));
  await openOrchestrator(page, made.orchestratorThreadId);
  const row = threadRow(page, made.briefed);
  await expect(row.getByTestId("overview-worker-starting")).toHaveText("Starting…");
  await expect(row).not.toContainText("Stopped");
  // Its feature card in the orchestrator's chat says the same, not "briefed".
  await expect(
    page
      .getByTestId("feature-card-worker")
      .filter({ has: page.locator(`a[href$="/t/${made.briefed}"]`) })
      .getByTestId("feature-card-now"),
  ).toHaveText("starting…");

  // On a card a worker's dot is its state's, as everywhere else: amber beside one that asks, never
  // the running blue of the station it stands at.
  for (const id of made.waiting) {
    await expect(
      page
        .getByTestId("feature-card-worker")
        .filter({ has: page.locator(`a[href$="/t/${id}"]`) })
        .first(),
    ).toHaveAttribute("data-dot", "needs");
  }

  // The Workers panel lists it as running, its state in words Starting.
  const panel = await workersPanel(page);
  const listed = panel
    .getByTestId("workers-group-running")
    .locator(`[data-testid="workers-panel-row"][data-thread-id="${made.briefed}"]`);
  await expect(listed).toHaveAttribute("data-dot", "working");
  await expect(listed).toHaveAttribute("title", /\nStarting…$/);
  // Both workers waiting on one shared approval are under Needs you, as the sidebar says they ask.
  for (const id of made.waiting) {
    await expect(
      panel
        .getByTestId("workers-group-needs")
        .locator(`[data-testid="workers-panel-row"][data-thread-id="${id}"]`),
    ).toHaveCount(1);
  }

  // Its own header says the same. The panel lists the workers now, so the sidebar folds its rows:
  // it opens from the panel's row, in the main view.
  await expect(row).toBeHidden();
  await listed.click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByTestId("worker-now-status")).toHaveText("starting…");
});
