import { expect, test } from "@playwright/test";

test("deletes a past session, then continues the latest one on the chosen effort", async ({
  page,
}) => {
  await page.goto("/new");
  await page.getByLabel("Effort").click();
  await page.getByRole("option", { name: "High effort", exact: true }).click();
  await expect(page.getByLabel("Effort")).toContainText("High effort");

  await page.getByRole("button", { name: "Resume a past session…" }).click();
  const picker = page.getByTestId("resume-sessions");
  const sessions = picker.getByTestId("past-session");
  await expect(sessions).toHaveCount(2);
  await page.getByRole("button", { name: "Delete “Add request tracing”" }).click();
  const confirm = picker.getByTestId("confirm-delete");
  await expect(confirm).toContainText("can't be undone");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(sessions).toHaveCount(1);
  await expect(picker).not.toContainText("Add request tracing");

  await page.getByRole("button", { name: "Continue latest session" }).click();
  await expect(page).toHaveURL(/\/t\/t-/);
  await expect(page.getByTestId("pane-header")).toContainText("Speed up the flaky retry suite");
  await expect(page.getByLabel("Effort")).toContainText("High effort");
});
