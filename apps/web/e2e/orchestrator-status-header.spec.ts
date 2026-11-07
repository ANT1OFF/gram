import { expect, test, type Page } from "@playwright/test";

import { openOrchestrator, threadRow } from "./thread-row";

// The line over the orchestrator's chat and its quiet stream, over the realistic scenario: the line
// says only what nothing else does (Since you left), digests that changed nothing for the user fold
// into one update with the orchestrator's replies to them, a merge still stands in the chat, and
// Show all activity, a view option in the title bar's "…" (or finding a folded reply), brings every
// digest and reply back.

/** The realistic "Gram" orchestrator, opened from the overview; what the scenario made. */
const openRealistic = async (page: Page) => {
  await page.addInitScript(() => sessionStorage.setItem("gram.mock.orchestration", "realistic"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  const made = await page.evaluate(async () => {
    const started = await window.gramMock!.startedRealistic();
    if (started === undefined)
      throw new Error("the mock did not start with the realistic scenario");
    return started;
  });
  await page
    .locator(`[data-testid="overview-workspace"][data-workspace-id="${made.workspaceId}"]`)
    .waitFor();
  await openOrchestrator(page, made.orchestratorThreadId);
  await page.getByLabel("Message", { exact: true }).waitFor();
  await expect(page.getByTestId("status-header")).toBeVisible();
  return made;
};

const quietUpdates = (page: Page) =>
  page.locator('[data-testid="update-block"][data-quiet="true"]');

/** Opens a thread from its sidebar row. */
const openThreadRow = async (page: Page, threadId: string) => {
  await threadRow(page, threadId).click();
  await page.waitForURL(new RegExp(`/t/${threadId}$`));
};

/** Show all activity, from the title bar's "…" under View, where the window's view options are. */
const allActivityItem = async (page: Page) => {
  await page.getByTestId("titlebar-overflow").click();
  await page.getByTestId("menu-view").click();
  const item = page.getByTestId("menu-all-activity");
  await expect(item).toBeVisible();
  return item;
};

/** Turns Show all activity over; one toggle, the menu closes on it. */
const toggleAllActivity = async (page: Page) => {
  await (await allActivityItem(page)).click();
  await expect(page.getByTestId("titlebar-overflow-menu")).toHaveCount(0);
};

/** Closes the title bar's menu from its View submenu: the submenu first, then the menu. */
const closeMenu = async (page: Page) => {
  await page.keyboard.press("Escape");
  if ((await page.getByTestId("titlebar-overflow-menu").count()) > 0)
    await page.keyboard.press("Escape");
  await expect(page.getByTestId("titlebar-overflow-menu")).toHaveCount(0);
};

test("the line over the chat says only Since you left; the counts are the sidebar's", async ({
  page,
}) => {
  const made = await openRealistic(page);
  const header = page.getByTestId("status-header");
  // No running, review or merged counts: the sidebar and the Board say them. No switch either:
  // Show all activity is a view option in the "…".
  for (const gone of ["status-running", "status-review", "status-merged", "status-all-activity"])
    await expect(page.getByTestId(gone)).toHaveCount(0);
  await expect(header).toHaveText(/^\s*Since you left\s*2 merged\s*$/);

  // Nothing in Gram waits on the user: the ask is billing-api's and the error a solo thread's.
  // The line doesn't repeat it: the sidebar's pill is the one count across every workspace,
  // with here and elsewhere on its hover, and each workspace's line its own share.
  await expect(header.getByTestId("status-waiting")).toHaveCount(0);
  await expect(header).not.toContainText("need you");
  const pill = page.getByTestId("overview-needs-you");
  await expect(pill).toHaveAttribute("data-count", "2");
  await expect(pill).toHaveAttribute("title", /\nHere \(Gram\): nothing needs you\n/);
  await expect(pill).toHaveAttribute("title", /\nbilling-api: 1 question/);
  await expect(pill).toHaveAttribute("title", /\nThreads outside a workspace: 1 error/);
  const gram = page.locator(
    `[data-testid="overview-workspace"][data-workspace-id="${made.workspaceId}"]`,
  );
  await expect(gram).toHaveAttribute("data-asks", "0");
  // The pill is the one way in: the title bar has no Inbox button beside it.
  await expect(page.getByTestId("inbox-button")).toHaveCount(0);
  // The pill opens the Inbox on the newest ask elsewhere, not on the error listed first.
  await pill.click();
  await expect(page.getByTestId("inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-detail")).toContainText("refund webhook");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inbox")).toBeHidden();

  // The menu's item is unchecked until it is turned on, and only an orchestrator's chat has it.
  await expect(await allActivityItem(page)).toHaveAttribute("aria-checked", "false");
  await closeMenu(page);
  await openThreadRow(page, made.searchWorker);
  await page.getByTestId("titlebar-overflow").click();
  await page.getByTestId("menu-view").click();
  await expect(page.getByTestId("titlebar-menu-view")).toBeVisible();
  await expect(page.getByTestId("menu-all-activity")).toHaveCount(0);
});

test("digests that changed nothing fold into one update; a merge stands; the toggle shows all", async ({
  page,
}) => {
  await openRealistic(page);
  await page.evaluate(() => window.gramMock!.simulateDigestStream());
  const transcript = page.getByTestId("transcript");
  // The run before the merge and the run after it are one update each, reading the newest reply.
  const last = quietUpdates(page).last();
  await expect(last).toHaveAttribute("data-digests", "5");
  await expect(last).toHaveAttribute("data-replies", "5");
  await expect(last.getByTestId("update-block-preview")).toContainText(
    "The ARM build is linking. Nothing is needed from you.",
  );
  await expect(transcript.getByText("Still on the ARM build, about 31 minutes in.")).toHaveCount(0);
  // The merge, and the orchestrator's reply to it, stand in the chat.
  await expect(transcript.getByText("Search in Settings is on main.")).toBeVisible();

  // A cut preview ends in words that say the line opens, and they turn to "Less" once it has.
  await expect(last.getByTestId("update-block-fold")).toHaveText("More");
  await expect(last.getByTestId("update-block-fold")).toBeVisible();

  // Opened, the update shows every reply it folded.
  await last.getByTestId("update-block-toggle").click();
  await expect(last.getByTestId("update-block-fold")).toHaveText("Less");
  await expect(last.getByTestId("update-block-reply")).toHaveCount(5);
  await expect(
    last
      .getByTestId("update-block-reply")
      .getByText("Still on the ARM build, about 31 minutes in."),
  ).toBeVisible();

  // Show all activity: no quiet update, every reply in the chat again.
  await toggleAllActivity(page);
  await expect(quietUpdates(page)).toHaveCount(0);
  // The transcript draws what is in view: the earlier run's replies, each in the chat again.
  await expect(
    transcript.getByText("Still building, 12 minutes in with no failures."),
  ).toBeVisible();
  await toggleAllActivity(page);
  await expect(quietUpdates(page).last()).toHaveAttribute("data-replies", "5");
});

test("finding a folded reply shows all activity and lands on it", async ({ page }) => {
  await openRealistic(page);
  await page.evaluate(() => window.gramMock!.simulateDigestStream());
  await expect(quietUpdates(page).last()).toBeVisible();
  await page.getByLabel("Message", { exact: true }).click();
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByLabel("Find in thread").fill("Clippy passed");
  await page.getByLabel("Find in thread").press("Enter");
  await expect(
    page.getByTestId("transcript").getByText(/Clippy passed about 19 minutes/),
  ).toBeInViewport();
  await expect(quietUpdates(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(await allActivityItem(page)).toHaveAttribute("aria-checked", "true");
});

test.describe(() => {
  // The pinned clock below is midday in this zone, whatever the machine's.
  test.use({ timezoneId: "UTC" });
  test("one line above the chat: Since you left on request, gone once dismissed", async ({
    page,
  }) => {
    // You left 12 minutes before the page loads: just after midnight that was the day before, which
    // the range dates. At midday it is the same day, two bare clocks.
    await page.clock.setFixedTime(new Date("2026-11-07T12:00:00Z"));
    const made = await openRealistic(page);
    const header = page.getByTestId("status-header");
    // Since you left is the line's one fold, as low as the row it sits in.
    const since = header.getByTestId("since-you-left");
    await expect(since).toBeVisible();
    await expect(since.getByTestId("since-merged")).toHaveText("2 merged");
    const box = await header.boundingBox();
    expect(box?.height ?? 0).toBeLessThanOrEqual(40);
    // The usage meter is the title bar's alone.
    await expect(header.getByTestId("status-limit")).toHaveCount(0);

    // The time range and each PR on request.
    await since.getByTestId("since-you-left-open").click();
    const detail = page.getByTestId("since-you-left-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(/Since you left\s*\d{2}:\d{2} to \d{2}:\d{2}/);
    await expect(detail.getByTestId("since-merged-detail")).toContainText("2 merged:");
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();

    // One fold on the line, no × beside it: Dismiss is in what it opens.
    await expect(since.getByRole("button")).toHaveCount(1);
    // Dismissed, it stays gone for that absence, even as the view opens again, and with nothing
    // left to say the line goes too: no empty band over the chat.
    await since.getByTestId("since-you-left-open").click();
    await detail.getByRole("button", { name: "Dismiss Since you left" }).click();
    await expect(page.getByTestId("since-you-left")).toHaveCount(0);
    await expect(page.getByTestId("status-header")).toHaveCount(0);
    await page.getByTestId("overview-needs-you").click();
    await page.keyboard.press("Escape");
    await openOrchestrator(page, made.orchestratorThreadId);
    await page.getByLabel("Message", { exact: true }).waitFor();
    await expect(page.getByTestId("status-header")).toHaveCount(0);
    await expect(page.getByTestId("since-you-left")).toHaveCount(0);
  });
});
