import { expect, test } from "@playwright/test";

test("creates a PR for an unpublished branch, pushing it first", async ({ page }) => {
  await page.goto("/t/t-dark");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "PR", exact: true }).click();
  await expect(panel.getByText("No PR for this branch")).toBeVisible();
  await expect(panel.getByTestId("push-button")).toHaveText("Publish branch");
  // The PR panel is where a branch is published; the pane header has no push button of its own.
  await expect(page.getByTestId("pane-header").getByTestId("push-button")).toHaveCount(0);

  await panel.getByTestId("create-pr-button").click();
  const dialog = page.getByTestId("create-pr-dialog");
  await expect(dialog).toContainText("origin doesn't have this branch's latest commits yet");
  await expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("Add dark mode toggle");
  await dialog.getByRole("button", { name: "Push and create" }).click();
  await expect(dialog).toBeHidden();

  // The thread's header shows the new PR, where its sidebar row used to.
  await expect(page.getByTestId("pane-pr-badge")).toContainText("#418");
  await expect(panel.getByTestId("push-button")).toBeHidden();
  await expect(panel.getByText("No PR for this branch")).toBeHidden();
});
