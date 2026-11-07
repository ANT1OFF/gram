import { expect, test, type Page } from "@playwright/test";

// A finished worker whose conversation isn't stored here (the realistic mock seeds none for its
// merged workers) shows what Gram kept of it, not "No messages yet"; a thread that never started
// still says that.
const openReleaseNotes = async (page: Page) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.orchestration", "realistic");
  });
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  await page.evaluate(async () => {
    if ((await window.gramMock!.startedRealistic()) === undefined)
      throw new Error("the mock did not start with the realistic scenario");
  });
  // Done starts folded to one row; its title opens it onto its rows.
  await page
    .getByTestId("overview-section-doneToday")
    .getByRole("button", { name: /^Done, \d+$/ })
    .click();
  await page.getByRole("button", { name: /^Release notes for 0.9, Gram, merged/ }).click();
  await expect(
    page.getByRole("heading", { name: "Worker: Release notes for 0.9", exact: true }),
  ).toBeVisible();
  return page.getByTestId("thread-outcome");
};

test('a finished worker with no messages shows its outcome, not "No messages yet"', async ({
  page,
}) => {
  await openReleaseNotes(page);
  const outcome = page.getByTestId("thread-outcome");
  await expect(outcome).toBeVisible();
  await expect(outcome.getByRole("heading", { name: /^Outcome/ })).toBeVisible();
  await expect(outcome.getByTestId("thread-outcome-note")).toContainText(
    "conversation isn't available on this computer",
  );
  await expect(outcome.getByTestId("thread-outcome-report")).toContainText(
    "0.9 notes cover undo, empty states and the new shortcuts.",
  );
  await expect(outcome.getByTestId("thread-outcome-report")).toContainText(
    /Last report · \d\d:\d\d/,
  );
  // What it ended with, from what Gram saved: its PR's state, its checks, its branch, its files.
  await expect(outcome.getByTestId("thread-outcome-pr-state")).toHaveText("· Merged");
  await expect(outcome.getByTestId("thread-outcome-checks")).toContainText("Passed");
  await expect(outcome.getByTestId("thread-outcome-branch")).toContainText("feat/release-notes");
  await expect(outcome.getByTestId("thread-outcome-branch")).toContainText("into main");
  await expect(outcome.getByTestId("thread-outcome-changed")).toContainText(
    "None left in its worktree; its changes are in PR #61",
  );
  const pr = outcome.getByTestId("thread-outcome-pr");
  await expect(pr).toContainText("#61");
  await expect(page.getByText("No messages yet.")).toHaveCount(0);
  // Its PR is a click away.
  await pr.click();
  await expect(page.getByRole("tab", { name: "PR", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("a finished worker's outcome lists its PR's files, each a click from its diff", async ({
  page,
}) => {
  const outcome = await openReleaseNotes(page);
  const card = outcome.getByTestId("thread-outcome-pr-files");
  await expect(card.getByRole("heading", { name: "Changed in PR #61" })).toBeVisible();
  await expect(card).toContainText("3 files +10 −1");
  const rows = card.getByTestId("thread-outcome-pr-file");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("docs/releases/0.9.md");
  await expect(rows.first()).toContainText("+4 −0");

  // A file opens the PR panel at that file, expanded.
  await card.locator('[data-path="CHANGELOG.md"]').click();
  await expect(page.getByRole("tab", { name: "PR", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const file = page
    .getByTestId("right-panel")
    .locator('[data-testid="diff-file"][data-path="CHANGELOG.md"]');
  await expect(file.locator("[data-diff-file-header]")).toHaveAttribute("aria-expanded", "true");
  await expect(file.getByTestId("patch")).toContainText("See [the release notes]");
});

test("a finished worker's outcome finds it in History, or resumes from its report as a draft", async ({
  page,
}) => {
  const outcome = await openReleaseNotes(page);
  await expect(outcome.getByTestId("thread-outcome-pr")).toHaveText(/^Open PR #61/);

  await outcome.getByRole("button", { name: "Find in History" }).click();
  const history = page.getByTestId("history");
  await expect(history.getByTestId("history-search")).toHaveValue("Release notes for 0.9");
  await page.keyboard.press("Escape");
  await expect(history).toHaveCount(0);

  await outcome.getByRole("button", { name: "Resume from report" }).click();
  // The normal New form, with the report as its brief: nothing starts until the user starts it.
  await expect(page).toHaveURL(/\/new-task/);
  const brief = page.getByLabel("What needs doing", { exact: true });
  await expect(brief).toHaveValue(/^Pick up where "Release notes for 0.9" left off\./);
  await expect(brief).toHaveValue(/0\.9 notes cover undo, empty states and the new shortcuts\./);
  await expect(page.getByRole("button", { name: /^Start/ }).first()).toBeVisible();
});
