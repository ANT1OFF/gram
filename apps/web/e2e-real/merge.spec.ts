import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { startHarness, type Harness } from "./harness";

// Flow 7: a PR with a red build reruns its failed checks, then squash-merges from the app, and the
// thread settles as merged until work carries on after the merge.
test.describe.configure({ mode: "serial" });

const BRANCH_NAME = "merge-e2e";

let h: Harness;
let page: Page;

test.beforeAll(async ({ browser }) => {
  h = await startHarness();
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page?.close();
  await h?.stop();
});

test("reruns failed checks, squash-merges from the PR panel, and the thread settles", async () => {
  await h.open(page, "/new");
  await page.getByRole("combobox", { name: "Project path" }).fill(h.repo);
  await expect(page.getByTestId("folder-status")).toBeVisible();
  await page
    .getByRole("radiogroup", { name: "Checkout" })
    .getByRole("radio", { name: "New worktree" })
    .click();
  await page.getByRole("textbox", { name: "Branch name" }).fill(BRANCH_NAME);
  await page.getByRole("combobox", { name: "First prompt" }).fill("Ship the banner");
  await page.getByRole("button", { name: "Create thread" }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/, { timeout: 30_000 });

  const worktree = h.worktreeOnBranch(BRANCH_NAME);
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, "src", "banner.ts"), 'export const banner = "Welcome";\n');
  h.git(worktree, "add", "-A");
  h.git(worktree, "commit", "-qm", "Add a banner");

  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "PR", exact: true }).click();
  await panel.getByTestId("push-button").click();
  await expect(panel.getByTestId("push-button")).toBeHidden();
  await panel.getByTestId("create-pr-button").click();
  await page.getByTestId("create-pr-dialog").getByRole("button", { name: "Create PR" }).click();
  await expect(page.getByTestId("pane-pr-badge")).toContainText("#1");

  // CI goes red; its run can be rerun from the Checks section.
  h.setChecks(1, "failing");
  const checks = panel.getByRole("region", { name: "Checks" });
  await expect(checks.getByTestId("check-run").filter({ hasText: "test" })).toContainText(
    "Failing",
    { timeout: 15_000 },
  );
  await checks.getByRole("button", { name: "Rerun failed" }).click();
  await expect(panel.getByText("Rerunning the failed jobs of 1 run.")).toBeVisible();
  expect(h.prs()[0]).toMatchObject({ reruns: ["9001"], checks: "pending" });
  await expect(checks.getByTestId("check-run").filter({ hasText: "test" })).toContainText(
    "Running",
    { timeout: 15_000 },
  );

  // The rerun passes; merge by squashing.
  h.setChecks(1, "passing");
  await expect(checks.getByTestId("check-run").filter({ hasText: "test" })).toContainText(
    "Passing",
    { timeout: 15_000 },
  );
  await panel.getByTestId("pr-actions").getByRole("button", { name: "Merge…" }).click();
  const dialog = page.getByTestId("pr-merge-dialog");
  await expect(dialog).toContainText("Merge #1 into main?");
  await expect(dialog.getByRole("radio", { name: "Squash and merge" })).toBeChecked();
  await dialog.getByRole("button", { name: "Squash and merge" }).click();
  await expect(dialog).toBeHidden();
  await expect(panel.getByText("Merged #1.")).toBeVisible();
  expect(h.prs()[0]).toMatchObject({ state: "MERGED", mergeMethod: "squash" });

  // The refreshed badge settles the thread: completed as merged, with the user told.
  await expect(page.getByTestId("toast").filter({ hasText: "#1 merged" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("pane-status")).toHaveText("Completed");
  await expect(panel.getByTestId("pr-actions")).toHaveCount(0);
  // Later sweeps see the same merged badge and don't notify again (toasts last six seconds).
  await page.waitForTimeout(3200);
  await expect(page.getByTestId("toast").filter({ hasText: "#1 merged" })).toHaveCount(1);

  // Work carried on after the merge takes the thread out of Settled; the merge doesn't put it back.
  writeFileSync(join(worktree, "src", "banner.ts"), 'export const banner = "Welcome back";\n');
  h.git(worktree, "commit", "-qam", "Reword the banner");
  await expect(page.getByTestId("pane-status")).not.toHaveText("Completed", { timeout: 15_000 });
  await page.waitForTimeout(3200);
  await expect(page.getByTestId("pane-status")).not.toHaveText("Completed");
});
