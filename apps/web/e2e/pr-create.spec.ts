import { expect, test } from "@playwright/test";

test("publishes a branch, opens its PR and shows the badge", async ({ page }) => {
  await page.goto("/t/t-dark");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "PR", exact: true }).click();
  await expect(panel.getByText("No PR for this branch")).toBeVisible();

  await panel.getByTestId("push-button").click();
  await expect(panel.getByTestId("push-button")).toBeHidden();

  await panel.getByTestId("create-pr-button").click();
  const dialog = page.getByTestId("create-pr-dialog");
  await expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("Add dark mode toggle");
  await expect(dialog.getByRole("textbox", { name: "Description" })).toHaveValue(
    /- Add dark palette tokens/,
  );
  await dialog.getByRole("checkbox", { name: "Draft" }).check();
  await dialog.getByRole("button", { name: "Create PR" }).click();
  await expect(dialog).toBeHidden();

  // The thread's header shows the new PR, where its sidebar row used to.
  const badge = page.getByTestId("pane-pr-badge");
  await expect(badge).toContainText("#418");
  await expect(panel.getByText("No PR for this branch")).toBeHidden();
});
