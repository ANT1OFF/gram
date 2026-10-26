import { expect, test } from "@playwright/test";

test("/new warns when the current checkout already has a thread, with ways forward", async ({
  page,
}) => {
  await page.goto("/new");
  const form = page.getByRole("form", { name: "New thread" });
  await form.getByRole("region", { name: "Recent" }).getByRole("button", { name: /^docs/ }).click();
  await form.getByRole("radio", { name: "Current checkout" }).click();

  const notice = form.getByTestId("checkout-in-use");
  await expect(notice).toContainText("“Rewrite the README” is already open in this checkout");

  // Create is held back until the warning is answered.
  await form.getByRole("button", { name: /Create thread/ }).click();
  await expect(page).toHaveURL(/\/new$/);

  await notice.getByRole("button", { name: "Use a new worktree instead" }).click();
  await expect(form.getByRole("radio", { name: "New worktree" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(notice).toBeHidden();

  await form.getByRole("radio", { name: "Current checkout" }).click();
  await form
    .getByTestId("checkout-in-use")
    .getByRole("button", { name: "Open “Rewrite the README”" })
    .click();
  await expect(page).toHaveURL(/\/t\/t-docs$/);
});

test("/new creates in a shared checkout when asked to anyway", async ({ page }) => {
  await page.goto("/new");
  const form = page.getByRole("form", { name: "New thread" });
  await form.getByRole("region", { name: "Recent" }).getByRole("button", { name: /^docs/ }).click();
  await form.getByRole("radio", { name: "Current checkout" }).click();
  await form.getByLabel("First prompt").fill("tidy the changelog");

  await form
    .getByTestId("checkout-in-use")
    .getByRole("button", { name: "Create here anyway" })
    .click();
  await expect(page).toHaveURL(/\/t\/t-mock-/);
});
