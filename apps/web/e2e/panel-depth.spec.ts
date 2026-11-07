import { expect, test } from "@playwright/test";
import { openPanelTab } from "./panel-tab";

test("a clean tree's Diff panel selects the branch and refreshes on demand", async ({ page }) => {
  await page.goto("/t/t-docs");
  const panel = page.getByTestId("diff-panel");
  await expect(panel.getByTestId("diff-fallback")).toHaveText(
    "No uncommitted changes. Showing branch vs main",
  );
  await expect(panel.getByTestId("diff-file")).toHaveCount(1);
  // The selected scope is the one shown: Branch, not Uncommitted over the branch's files.
  await expect(panel.getByRole("radio", { name: "Branch" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(panel.getByRole("radio", { name: "Uncommitted" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(panel.getByTestId("diff-branch")).toContainText("vs main");

  await panel.getByRole("button", { name: "Refresh diff" }).click();
  await expect(panel.getByRole("button", { name: "Refresh diff" })).toBeEnabled();
  await expect(panel.getByTestId("diff-file")).toHaveCount(1);
});

test("Uncommitted picked on a clean tree says so and leads back to the branch", async ({
  page,
}) => {
  await page.goto("/t/t-docs");
  const panel = page.getByTestId("diff-panel");
  await expect(panel.getByTestId("diff-file")).toHaveCount(1);
  await panel.getByRole("radio", { name: "Uncommitted" }).click();
  await expect(panel.getByTestId("diff-empty")).toHaveText("No uncommitted changes on docs/readme");
  await expect(panel.getByTestId("diff-file")).toHaveCount(0);
  await panel.getByRole("button", { name: "Show branch vs main" }).click();
  await expect(panel.getByRole("radio", { name: "Branch" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(panel.getByTestId("diff-file")).toHaveCount(1);
});

test("a commit that empties the tree moves the Diff panel to the branch", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("diff-panel");
  const scope = (name: string) => panel.getByRole("radio", { name });
  await expect(scope("Uncommitted")).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByTestId("diff-file").first()).toBeVisible();
  await page.waitForFunction(() => window.gramMock !== undefined);
  const publish = (changedFiles: number, changesToken: string) =>
    page.evaluate(
      (git) =>
        window.gramMock!.world.publishGit(
          "t-flaky" as never,
          {
            repo: true,
            branch: "fix/flaky-retry",
            worktree: true,
            head: "a1b2c3d",
            changesToken: git.changesToken,
            changedFiles: git.changedFiles,
            base: "origin/main",
            behindBase: 0,
            aheadBase: 3,
            conflicts: false,
          } as never,
        ),
      { changedFiles, changesToken },
    );
  await publish(0, "committed");
  await expect(scope("Branch")).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByTestId("diff-fallback")).toHaveText(
    "No uncommitted changes. Showing branch vs main",
  );
  await expect(panel.getByTestId("diff-file")).toHaveCount(1);
  // New work in the tree brings Uncommitted back.
  await publish(2, "edited");
  await expect(scope("Uncommitted")).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByTestId("diff-fallback")).toHaveCount(0);
});

test("the PR panel links commits, shows authors and gives file rows actions", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await openPanelTab(page.getByTestId("right-panel"), "PR");
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
