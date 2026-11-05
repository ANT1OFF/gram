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

  // Nothing in Gram waits on the user: the one ask is billing-api's, so no amber here.
  const waiting = header.getByTestId("status-waiting");
  await expect(waiting).toHaveAccessibleName("0 waiting on you, open Inbox");
  await waiting.click();
  await expect(page.getByTestId("inbox")).toBeVisible();
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

test("Since you left is one line of what merged while you were away", async ({ page }) => {
  await openRealistic(page);
  const since = page.getByTestId("since-you-left");
  await expect(since).toBeVisible();
  await expect(since.getByTestId("since-merged")).toContainText("2 merged:");
  // One line: no taller than a row.
  const box = await since.boundingBox();
  expect(box?.height ?? 0).toBeLessThanOrEqual(40);
  await since.getByRole("button", { name: "Dismiss" }).click();
  await expect(since).toHaveCount(0);
});
