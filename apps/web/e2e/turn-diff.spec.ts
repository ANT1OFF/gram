import { expect, test } from "@playwright/test";

test("a finished turn's files chip opens the Diff panel at that turn", async ({ page }) => {
  await page.goto("/t/t-deps");
  const chip = page.getByTestId("turn-files-chip");
  await expect(chip).toHaveText("2 files changed");

  await chip.click();
  const panel = page.getByTestId("diff-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("radio", { name: "Turn" })).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByRole("combobox", { name: "Turn" })).toHaveValue("turn-deps-1");
  await expect(panel.getByTestId("diff-file")).toHaveCount(2);
  await expect(panel.getByTestId("diff-files").getByText("package.json")).toBeVisible();

  // Switching scope and back keeps the turn.
  await panel.getByRole("radio", { name: "Uncommitted" }).click();
  await panel.getByRole("radio", { name: "Turn" }).click();
  await expect(panel.getByRole("combobox", { name: "Turn" })).toHaveValue("turn-deps-1");
});
