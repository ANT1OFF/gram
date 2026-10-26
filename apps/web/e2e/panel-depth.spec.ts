import { expect, test } from "@playwright/test";

test("a clean tree's Diff panel falls back to the branch and refreshes on demand", async ({
  page,
}) => {
  await page.goto("/t/t-docs");
  const panel = page.getByTestId("diff-panel");
  await expect(panel.getByTestId("diff-fallback")).toHaveText(
    "No uncommitted changes. Showing branch vs main",
  );
  await expect(panel.getByTestId("diff-file")).toHaveCount(1);

  await panel.getByRole("button", { name: "Refresh diff" }).click();
  await expect(panel.getByRole("button", { name: "Refresh diff" })).toBeEnabled();
  await expect(panel.getByTestId("diff-file")).toHaveCount(1);
});

test("the PR panel links commits, shows authors and gives file rows actions", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await page.getByRole("tab", { name: "PR", exact: true }).click();
  const panel = page.getByTestId("pr-panel");
  await expect(panel.getByTestId("pr-author")).toHaveText("by alex");

  const commits = panel.getByRole("region", { name: "Commits" });
  await commits.getByRole("button", { name: /Commits/ }).click();
  const pagesBefore = page.context().pages().length;
  await commits.getByRole("button", { name: "Open commit 3f9c2d1 on GitHub" }).click();
  expect(page.context().pages()).toHaveLength(pagesBefore);

  const file = panel.getByTestId("diff-file");
  await expect(
    file.getByRole("button", { name: "Open src/retry.test.ts in editor" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh pull request" }).click();
  await expect(panel.getByTestId("pr-author")).toHaveText("by alex");

  await file.getByRole("button", { name: "Show src/retry.test.ts in Files" }).click();
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
