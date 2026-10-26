import { expect, test } from "@playwright/test";
import { threadRow } from "./thread-row";

test("the PR panel shows reviewers, requests a review and edits labels", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await page.getByRole("tab", { name: "PR", exact: true }).click();
  const panel = page.getByTestId("pr-panel");

  const reviewers = panel.getByRole("list", { name: "Reviewers" });
  await expect(reviewers.getByRole("listitem")).toHaveCount(4);
  await expect(reviewers).toContainText("reviewer: Changes requested");

  await panel.getByRole("button", { name: "Request review…" }).click();
  await panel
    .getByRole("list", { name: "Suggested reviewers" })
    .getByRole("button", { name: "sam", exact: true })
    .click();
  await panel.getByRole("button", { name: "Request", exact: true }).click();
  await expect(panel.getByText("Asked sam to review")).toBeVisible();
  await expect(reviewers).toContainText("sam: Review requested");

  const labels = panel.getByRole("list", { name: "Labels" });
  await expect(labels.getByRole("listitem")).toHaveText(["tests", "flaky"]);
  await panel.getByRole("button", { name: "Remove label flaky" }).click();
  await expect(labels.getByRole("listitem")).toHaveText(["tests"]);

  await panel.getByRole("button", { name: "Add label…" }).click();
  const filter = panel.getByLabel("Filter repository labels");
  await filter.fill("win");
  await filter.press("Enter");
  await expect(labels.getByRole("listitem")).toHaveText(["tests", "windows"]);
});

test("⌘K checks a PR out into a new worktree and a thread that follows it", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill(">Check out PR");
  await palette.getByRole("combobox").press("Enter");

  const dialog = page.getByTestId("checkout-pr-dialog");
  await expect(dialog.getByLabel("Project")).toHaveValue("/Users/dev/code/api");
  await dialog.getByLabel("Pull request number or URL").fill("#412");
  await dialog.getByRole("button", { name: "Check out" }).click();
  await expect(dialog).toBeHidden();

  await expect(page).toHaveURL(/\/t\/t-(?!flaky)/);
  await expect(page.getByTestId("pane-header").first()).toContainText(
    "#412 Make the retry test deterministic",
  );
  await page.getByRole("tab", { name: "PR", exact: true }).click();
  await expect(page.getByTestId("pr-binding-status")).toHaveText("Following example/api#412");
});
