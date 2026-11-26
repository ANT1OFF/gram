import { expect, test } from "@playwright/test";
import { ThreadId } from "@gram/contracts";
import { shot } from "./shots";

test("shows the thread's worktree outcome and opens the captured log", async ({ page }) => {
  await page.goto("/t/t-deps");
  await expect(page.getByTestId("transcript").getByText("Bumped", { exact: false })).toBeVisible();
  const notices = page.getByRole("complementary", { name: "Worktree hooks" });
  await expect(notices).toHaveCount(0);
  await shot(page, { path: "e2e/__screenshots__/worktree-hooks-before.png" });
  await page.evaluate((id) => {
    const world = window.gramMock!.world;
    const { checkout } = world.summary(id).thread;
    world.updateThread(id, {
      worktreeHooks: [
        {
          checkout: checkout.path,
          generation: "fixture-worktree",
          kind: "setup",
          path: ".gram/setup",
          result: {
            status: "failed",
            durationMs: 820,
            reason: "The hook exited with status 2.",
            log: "Fixture dependency setup failed.\n",
          },
        },
      ],
    });
  }, ThreadId.make("t-deps"));
  await expect(notices.getByText("Setup failed", { exact: true })).toBeVisible();
  await expect(notices.getByText("Fixture dependency setup failed.")).toBeHidden();
  await notices.getByText("Setup failed", { exact: true }).click();
  await expect(notices.getByText("The hook exited with status 2.")).toBeVisible();
  await expect(notices.getByLabel("Setup log")).toHaveText("Fixture dependency setup failed.");
  await shot(page, { path: "e2e/__screenshots__/worktree-hooks-after.png" });
});
