import { expect, test } from "@playwright/test";
import { threadRow } from "./thread-row";

test("removes an unused worktree from ⌘K, then binds a PR and watches its CI", async ({ page }) => {
  // Wide enough that the one bar keeps the PR badge among its chips; narrower, it folds away.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill(">Worktrees");
  await palette.getByRole("combobox").press("Enter");

  const dialog = page.getByTestId("worktrees-dialog");
  await expect(dialog.getByRole("listitem").first()).toHaveAccessibleName("Main checkout");
  const flaky = dialog.getByRole("listitem", { name: "fix/flaky-retry" });
  await expect(flaky).toContainText("Close the thread to remove its worktree");

  const experiment = dialog.getByRole("listitem", { name: "experiment/cache" });
  await expect(experiment).toContainText("No thread");
  await expect(experiment.getByTestId("worktree-warning")).toContainText("2 uncommitted changes");
  await experiment.getByRole("button", { name: "Remove…" }).click();
  await expect(experiment).toContainText("Bash(pnpm test:*)");
  await experiment.getByRole("button", { name: "Delete worktree" }).click();
  await expect(experiment).toContainText("Delete it anyway?");
  await experiment.getByRole("button", { name: "Delete anyway" }).click();
  await expect(experiment).toHaveCount(0);
  await expect(dialog.getByRole("status")).toContainText(
    "Removed the worktree folder cache-experiment",
  );
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();

  // The thread header's PR badge opens the PR panel.
  await page.getByTestId("pane-pr-badge").click();
  const panel = page.getByTestId("right-panel");
  const binding = panel.getByTestId("pr-watch");
  const watch = binding.getByRole("switch", { name: "Watch CI" });
  await expect(watch).toHaveAttribute("aria-checked", "false");
  await watch.click();
  await expect(watch).toHaveAttribute("aria-checked", "true");
  await expect(binding.getByTestId("pr-binding-status")).toHaveText("Following example/api#412");

  await binding.getByRole("button", { name: "Unbind" }).click();
  await expect(binding.getByTestId("pr-binding-status")).toHaveCount(0);
  await expect(watch).toHaveAttribute("aria-checked", "false");

  await panel.getByRole("button", { name: "More PR actions" }).click();
  await page.getByRole("menuitem", { name: "Bind another PR…" }).click();
  await binding.getByLabel("Pull request number or URL").fill("#412");
  await binding.getByRole("button", { name: "Bind", exact: true }).click();
  await expect(binding.getByTestId("pr-binding-status")).toHaveText("Following example/api#412");
  await watch.click();
  await expect(watch).toHaveAttribute("aria-checked", "true");
});

test("selects archived and merged workers' worktrees in bulk and closes the workers with them", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  await page.evaluate(async () => {
    if (!(await window.gramMock?.simulateFinishedWork())) {
      throw new Error("the mock API isn't on this page");
    }
  });

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill(">Worktrees");
  await palette.getByRole("combobox").press("Enter");
  const dialog = page.getByTestId("worktrees-dialog");

  // Four merged workers and one archived; the delivered one isn't finished enough to offer.
  await expect(dialog.getByText("5 worktrees of archived or merged workers")).toBeVisible();
  const delivered = dialog.getByRole("listitem", { name: "feat/changelog-tool" });
  await expect(delivered.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog.getByRole("listitem", { name: "feat/sse-spike" })).toContainText(
    "Archived worker",
  );
  await dialog.getByRole("button", { name: "Select all 5" }).click();
  await expect(dialog.getByTestId("worktree-selection")).toHaveText("5 selected · 6.0 GB");

  await dialog.getByRole("button", { name: "Remove 5 worktrees…" }).click();
  const bulk = dialog.getByTestId("worktree-bulk-remove");
  await expect(bulk).toContainText("freeing 6.0 GB");
  await expect(bulk).toContainText("5 finished workers using them are closed too.");
  await bulk.getByRole("button", { name: "Delete 5 worktrees" }).click();

  await expect(dialog.getByRole("status")).toHaveText(
    "Removed 5 worktree folders and closed 5 finished workers. Their branches and commits are kept.",
  );
  await expect(dialog.getByRole("listitem", { name: "feat/sse-spike" })).toHaveCount(0);
  await expect(delivered).toBeVisible();
});
