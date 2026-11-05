import { expect, test } from "@playwright/test";

// A finished worker whose conversation isn't stored here (the realistic mock seeds none for its
// merged workers) shows what Gram kept of it, not "No messages yet"; a thread that never started
// still says that.
test('a finished worker with no messages shows its outcome, not "No messages yet"', async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.orchestration", "realistic");
  });
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  await page.evaluate(async () => {
    if ((await window.gramMock!.startedRealistic()) === undefined)
      throw new Error("the mock did not start with the realistic scenario");
  });
  await page.getByRole("button", { name: /^Release notes for 0.9, Gram, merged/ }).click();
  await expect(
    page.getByRole("heading", { name: "Worker: Release notes for 0.9", exact: true }),
  ).toBeVisible();

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
