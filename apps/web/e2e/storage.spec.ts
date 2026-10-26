import { expect, test } from "@playwright/test";

test("lists worktrees by group, cleans up inactive ones and asks by name before losing work", async ({
  page,
}) => {
  await page.goto("/settings/storage");
  const storage = page.getByTestId("storage-page");
  await expect(storage.getByTestId("storage-disk")).toContainText("32.4 GB free");

  // A thread's worktree can be opened, never removed from here.
  const inUse = storage.getByTestId("storage-group-inUse");
  const flaky = inUse.getByRole("listitem", { name: "fix/flaky-retry" });
  await expect(
    flaky.getByRole("button", { name: "Open the thread of fix/flaky-retry" }),
  ).toBeVisible();
  await expect(flaky.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  await expect(storage.getByTestId("storage-group-removable")).toContainText("#212 merged");
  await expect(storage.getByTestId("storage-group-foreign")).toContainText("agent-shell-3f9a1c");

  // The sweep is on unless turned off, and now covers every thread.
  const sweep = storage.getByRole("switch", { name: "Clean up finished threads" });
  await expect(sweep).toBeChecked();
  await expect(storage.getByLabel("Remove after (days)")).toHaveValue("14");
  await sweep.uncheck();
  await expect
    .poll(() => page.evaluate(async () => (await window.gramMock?.getSettings())?.workspaces))
    .toMatchObject({ worktreeSweep: false });
  await sweep.check();

  // Clean up inactive: the plan and its size first, then one confirmation.
  await storage.getByRole("radio", { name: "60 days" }).click();
  await storage.getByTestId("storage-cleanup-inactive").click();
  const plan = page.getByTestId("storage-inactive-plan");
  await expect(plan.getByTestId("storage-plan-summary")).toHaveText(
    "3 worktrees, 4.2 GB. Branches stay, so any can be restored.",
  );
  await expect(plan).toContainText("chore/deps-bump");
  await expect(plan).not.toContainText("wip/diff-perf");
  await plan.getByRole("button", { name: "Remove 3 worktrees" }).click();
  await expect(storage.getByTestId("storage-status")).toHaveText(
    "Removed 2 worktrees, 4.2 GB freed. Branches kept. Pruned 1 stale registration.",
  );
  await expect(storage.getByRole("listitem", { name: "chore/deps-bump" })).toHaveCount(0);

  // Work at risk: the confirmation names the worktree, and cancelling keeps it.
  const kept = storage.getByTestId("storage-group-kept");
  const wip = kept.getByRole("listitem", { name: "wip/diff-perf" });
  await wip.getByRole("button", { name: "Remove wip/diff-perf" }).click();
  const confirm = page.getByTestId("storage-confirm");
  await expect(confirm.getByRole("heading")).toHaveText("Remove wip/diff-perf?");
  await expect(confirm.getByTestId("storage-confirm-risk")).toContainText(
    "/Users/dev/code/api/.worktrees/wip-diff-perf has 3 uncommitted changes",
  );
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(wip).toBeVisible();
  await wip.getByRole("button", { name: "Remove wip/diff-perf" }).click();
  await confirm.getByRole("button", { name: "Remove and lose it" }).click();
  await expect(wip).toHaveCount(0);

  // Foreign worktrees: the bulk prune drops only registrations whose folder is gone; removing
  // another tool's folder asks first, by name, even when it has nothing to lose.
  const foreign = storage.getByTestId("storage-group-foreign");
  await foreign.getByRole("button", { name: "Prune 1…" }).click();
  await expect(confirm.getByRole("heading")).toHaveText("Prune 1 stale registration?");
  await expect(confirm).toContainText("codex-wt-5521");
  await confirm.getByRole("button", { name: "Prune" }).click();
  await expect(foreign.getByRole("listitem")).toHaveCount(2);
  await foreign.getByRole("button", { name: "Remove agent-shell-3f9a1c" }).click();
  await expect(confirm.getByTestId("storage-confirm-risk")).toHaveText(
    "/private/tmp/agent-shell-3f9a1c wasn't made by Gram. Its folder is deleted; its branch stays.",
  );
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(foreign.getByRole("listitem")).toHaveCount(1);
  await expect(foreign).toContainText("agent-shell-77e0b2");
});
