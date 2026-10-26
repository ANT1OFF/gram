import { expect, test } from "@playwright/test";

import { openHeaderMore } from "./more-menu";

test("a thread whose worktree was deleted says so, and refuses a send with why", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const composer = page.getByLabel("Message", { exact: true });
  await expect(composer).toBeVisible();
  await expect(page.getByTestId("folder-missing-notice")).toBeHidden();

  await page.evaluate(() => window.gramMock?.simulateMissingFolder("t-flaky" as never));
  const notice = page.getByTestId("folder-missing-notice");
  await expect(notice).toContainText("worktree was deleted outside Gram");
  await expect(notice).toContainText("commits on fix/flaky-retry are kept");
  await expect(page.getByTestId("pane-folder-missing")).toContainText("Folder missing");
  // Its last read had nothing to push, and a deleted checkout pushes nothing anyway: More…, where
  // a push is offered, has none.
  const palette = await openHeaderMore(page);
  await expect(palette.getByRole("option", { name: "Copy fix/flaky-retry" })).toBeVisible();
  await expect(palette.getByRole("option", { name: /^(Push|Publish)/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await composer.fill("carry on");
  await composer.press("ControlOrMeta+Enter");
  await expect(page.getByTestId("composer-toolbar")).toContainText(
    "This thread's folder no longer exists",
  );
  await expect(composer).toHaveValue("carry on");
  if (process.env["GRAM_SCREENSHOTS"] !== undefined) {
    await page.screenshot({ path: `${process.env["GRAM_SCREENSHOTS"]}/missing-banner.png` });
  }

  await notice.getByRole("button", { name: "Close thread…" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  await notice.getByRole("button", { name: "Restore worktree" }).click();
  await expect(
    page.getByTestId("toast").filter({ hasText: "Restored fix/flaky-retry" }),
  ).toContainText("Work that wasn't committed couldn't be recovered");
  await expect(notice).toBeHidden();
  await expect(page.getByTestId("pane-folder-missing")).toHaveCount(0);
});

test("a branch gone everywhere is recreated from its PR's head, when asked", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.evaluate(() =>
    window.gramMock?.simulateMissingFolder("t-flaky" as never, {
      branchGone: { repo: "example/api", number: 412 },
    }),
  );
  const notice = page.getByTestId("folder-missing-notice");
  await notice.getByRole("button", { name: "Restore worktree" }).click();
  await expect(page.getByTestId("restore-worktree-problem")).toContainText(
    "It can be recreated from #412's head",
  );
  if (process.env["GRAM_SCREENSHOTS"] !== undefined) {
    await page.screenshot({ path: `${process.env["GRAM_SCREENSHOTS"]}/branch-gone.png` });
  }
  await notice.getByRole("button", { name: "Recreate from #412" }).click();
  await expect(
    page.getByTestId("toast").filter({ hasText: "from its pull request's head" }),
  ).toBeVisible();
  await expect(notice).toBeHidden();
});
