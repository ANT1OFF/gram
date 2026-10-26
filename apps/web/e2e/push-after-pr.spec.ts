import { expect, test } from "@playwright/test";

import { openHeaderMore } from "./more-menu";

test("a branch with a PR pushes follow-up commits from the PR panel and More…", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "PR", exact: true }).click();
  await expect(panel.getByTestId("pr-panel")).toBeVisible();
  await expect(panel.getByTestId("pr-panel-push")).toBeHidden();

  // The agent commits twice more after the PR opened.
  await page.evaluate(() => window.gramMock?.simulateUnpushed("t-flaky" as never, 2));
  const push = panel.getByTestId("pr-panel-push").getByRole("button", { name: "Push 2 commits" });
  await expect(push).toBeVisible();

  // The header has no Push; the thread menu's More… has it, with the branch.
  const palette = await openHeaderMore(page);
  await expect(palette.getByRole("option", { name: "Push 2 commits" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await push.click();
  await expect(
    page.getByTestId("toast").filter({ hasText: "Pushed fix/flaky-retry" }),
  ).toBeVisible();
  await expect(panel.getByTestId("pr-panel-push")).toBeHidden();
});
