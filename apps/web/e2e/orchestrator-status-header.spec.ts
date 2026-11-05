import { expect, test, type Page } from "@playwright/test";

import { openOrchestrator } from "./thread-row";

// The orchestrator's status header and its quiet chat, over the realistic scenario: the header's
// counts open the views they count, digests that changed nothing for the user fold into one update
// with the orchestrator's replies to them, a merge still stands in the chat, and Show all activity
// (or finding a folded reply) brings every digest and reply back.

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

test("the header counts what runs, waits, is in review and merged, and opens each view", async ({
  page,
}) => {
  const made = await openRealistic(page);
  const header = page.getByTestId("status-header");
  const running = header.getByTestId("status-running");
  await expect(running).toHaveAccessibleName(`${made.running.length} running, open Workers`);
  // Hover names each running worker with what it is doing.
  await running.hover();
  const hinted = page.getByTestId("status-hint-worker");
  await expect(hinted).toHaveCount(made.running.length);
  await expect(hinted.first()).toContainText(" · ");
  await running.click();
  await expect(page.getByTestId("workers-list")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("workers-list")).toHaveCount(0);

  // Nothing in Gram waits on the user: the ask is billing-api's and the error a solo thread's.
  // The header doesn't repeat it: the sidebar's pill is the one count across every workspace,
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

  const merged = header.getByTestId("status-merged");
  await expect(merged).toHaveAccessibleName(/^[1-9]\d* merged today, open History$/);
  await merged.click();
  await expect(page.getByTestId("history")).toBeVisible();
  await expect(
    page.getByTestId("history").locator('[data-history-filter="workers"]'),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("history")).toHaveCount(0);

  await header.getByTestId("status-review").click();
  await expect(page.getByTestId("rail-board")).toBeVisible();
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

  // Opened, the update shows every reply it folded.
  await last.getByTestId("update-block-toggle").click();
  await expect(last.getByTestId("update-block-reply")).toHaveCount(5);
  await expect(
    last
      .getByTestId("update-block-reply")
      .getByText("Still on the ARM build, about 31 minutes in."),
  ).toBeVisible();

  // Show all activity: no quiet update, every reply in the chat again.
  await page.getByTestId("status-all-activity").click();
  await expect(quietUpdates(page)).toHaveCount(0);
  // The transcript draws what is in view: the earlier run's replies, each in the chat again.
  await expect(
    transcript.getByText("Still building, 12 minutes in with no failures."),
  ).toBeVisible();
  await page.getByTestId("status-all-activity").click();
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
  await expect(page.getByTestId("status-all-activity")).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByTestId("transcript").getByText(/Clippy passed about 19 minutes/),
  ).toBeInViewport();
});

test("one row above the chat: counts, Since you left on request, no second usage meter", async ({
  page,
}) => {
  const made = await openRealistic(page);
  const header = page.getByTestId("status-header");
  // Since you left is a chip in the header's row, not a band of its own.
  const since = header.getByTestId("since-you-left");
  await expect(since).toBeVisible();
  await expect(since.getByTestId("since-merged")).toHaveText("2 merged");
  const box = await header.boundingBox();
  expect(box?.height ?? 0).toBeLessThanOrEqual(40);
  // The usage meter is the title bar's alone.
  await expect(header.getByTestId("status-limit")).toHaveCount(0);
  // The running workers' names are on hover, not in the row.
  await expect(header.getByTestId("status-running")).toHaveText(/^\d+\s*running$/);

  // The time range and each PR on request.
  await since.getByTestId("since-you-left-open").click();
  const detail = page.getByTestId("since-you-left-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(/Since you left\s*\d{2}:\d{2} to \d{2}:\d{2}/);
  await expect(detail.getByTestId("since-merged-detail")).toContainText("2 merged:");
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();

  // Dismissed, it stays gone for that absence, even as the view opens again.
  await since.getByRole("button", { name: "Dismiss Since you left" }).click();
  await expect(header.getByTestId("since-you-left")).toHaveCount(0);
  await page.getByTestId("overview-needs-you").click();
  await page.keyboard.press("Escape");
  await openOrchestrator(page, made.orchestratorThreadId);
  await expect(page.getByTestId("status-header")).toBeVisible();
  await expect(page.getByTestId("since-you-left")).toHaveCount(0);
});

test("short of room the strip drops whole items, never their words, and the switch follows the counts", async ({
  page,
}) => {
  await openRealistic(page);
  const header = page.getByTestId("status-header");
  await expect(header.getByTestId("since-you-left")).toBeVisible();
  /** The items a user can see and reach, by their words. */
  const shown = () =>
    header.evaluate((strip) =>
      [...strip.querySelectorAll<HTMLElement>('[data-testid="status-items"] > *')]
        .filter((item) => !item.inert)
        .map((item) => item.innerText.replace(/\s+/g, " ").trim()),
    );
  const wide = await shown();
  expect(wide).toEqual([
    expect.stringMatching(/^\d+ running$/),
    expect.stringMatching(/^\d+ in review$/),
    expect.stringMatching(/^\d+ merged today$/),
    expect.stringMatching(/^Since you left 2 merged/),
  ]);

  // As the Inbox docks beside it, the chat narrows: the last items go whole.
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect.poll(async () => (await shown()).length).toBeLessThan(wide.length);
  const narrow = await shown();
  for (const item of narrow) expect(item).toMatch(/^\d+ [a-z]|^Since you left/);
  // No two counts read the same: a bare "merged" never stands beside "merged today".
  expect(narrow.filter((item) => /^\d+ merged$/.test(item))).toEqual([]);
  // The switch sits after the last count shown, clear of the title bar's "…" over the row's end.
  const items = await header.getByTestId("status-items").evaluate((row) => {
    const last = [...row.children].filter((child) => !(child as HTMLElement).inert).at(-1)!;
    return last.getBoundingClientRect().right;
  });
  const control = (await header.getByTestId("status-all-activity-control").boundingBox())!;
  expect(control.x).toBeGreaterThan(items);
  expect(control.x - items).toBeLessThanOrEqual(16);
  // Its words shorten but stay.
  expect(await header.locator("label").innerText()).toMatch(/^(Show all activity|All activity)$/);
});
