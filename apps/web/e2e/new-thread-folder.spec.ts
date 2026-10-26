import { expect, test } from "@playwright/test";

test("a folder without git runs in place, with worktree options disabled", async ({ page }) => {
  await page.goto("/new");
  const form = page.getByRole("form", { name: "New thread" });
  await page.getByRole("combobox", { name: "Project path" }).fill("~/Documents/code/sandbox");

  await expect(form.getByTestId("checkout-note")).toContainText("Not a git repository");
  await expect(form.getByRole("radio", { name: "Current checkout" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(form.getByRole("radio", { name: "New worktree" })).toBeDisabled();
  await expect(form.getByRole("radio", { name: "Existing worktree" })).toBeDisabled();

  await form.getByLabel("First prompt").fill("notes, please");
  await form.getByRole("button", { name: /Create thread/ }).click();
  await expect(page).toHaveURL(/\/t\/t-/);
});
