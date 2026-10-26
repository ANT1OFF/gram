import { expect, test } from "@playwright/test";

test("the current checkout fetches, shows how far behind it is and fast-forwards", async ({
  page,
}) => {
  await page.goto("/new");
  const form = page.getByRole("form", { name: "New thread" });
  await page.getByRole("combobox", { name: "Project path" }).fill("~/code/api");
  await form.getByRole("radio", { name: "Current checkout" }).click();

  const freshness = form.getByTestId("base-freshness");
  await expect(freshness).toContainText("origin/main may be behind origin");
  await expect(form.getByTestId("upstream-sync")).toHaveCount(0);

  await freshness.getByRole("button", { name: "Fetch" }).click();
  await expect(form.getByText("Fetched 2 new commits into origin/main.")).toBeVisible();
  const sync = form.getByTestId("upstream-sync");
  await expect(sync).toContainText("main is 2 commits behind origin/main.");

  await sync.getByRole("button", { name: "Fast-forward" }).click();
  await expect(form.getByText("Fast-forwarded main by 2 commits to origin/main.")).toBeVisible();
});
