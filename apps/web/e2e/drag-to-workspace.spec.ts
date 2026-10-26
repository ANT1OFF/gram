import { expect, test, type Page } from "@playwright/test";

import { openMore } from "./more-menu";
import { threadRow } from "./thread-row";

// A solo thread joins a workspace from its row's More…: ⌘K's Add to workspace…, which names the
// repo a join adds and refuses a thread with no worktree of its own. (The overview takes no drop
// of a row onto a workspace; a row drags onto a grid pane instead.)

/** The api workspace with its orchestrator open and one worker, as the mock's scenario makes it. */
const simulate = (page: Page) =>
  page.evaluate(async () => {
    const made = await window.gramMock?.simulateOrchestration();
    if (!made) throw new Error("the mock API isn't on this page");
    return made;
  });

const workspaceName = (page: Page) =>
  page.evaluate(async () => (await window.gramMock!.listWorkspaces())[0]!.workspace.name);

test("without a mouse, More… on the row hands it to the workspace", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await simulate(page);
  const name = await workspaceName(page);

  const solo = page.locator('[data-testid="overview-solo"][data-thread-id="t-deps"]');
  await expect(solo).toBeVisible();
  await solo.focus();
  await page.keyboard.press("Shift+F10");
  const more = page.getByRole("menuitem", { name: "More…" });
  await expect(more).toBeVisible();
  // The menu takes the focus a frame after it shows; End pressed sooner is the row's.
  await expect(page.getByRole("menu")).toBeFocused();
  await page.keyboard.press("End");
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  const palette = page.getByTestId("command-palette");
  await expect(palette.getByTestId("palette-scope")).toBeVisible();
  await page.keyboard.type("Add to workspace");
  await expect(palette.getByRole("option", { name: "Add to workspace…" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(palette.getByRole("option", { name, exact: true })).toBeVisible();
  await page.keyboard.press("Enter");

  // A worker now: no longer a solo thread, and the workspace is no longer one it could join.
  await expect(solo).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.gramMock!.threadJoinTargets("t-deps" as never))).map(
        (target) => target.workspaceId,
      ),
    )
    .not.toContain(made.workspaceId);
});

test("Add to workspace… names the repo it adds, and refuses a main checkout", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  await simulate(page);
  const name = await workspaceName(page);

  // Rewrite the README runs in the docs repo's main checkout: no worktree of its own to work in.
  let palette = await openMore(page, threadRow(page, "t-docs"));
  const join = palette.getByRole("option", { name: "Add to workspace…" });
  await expect(join).toHaveAttribute("aria-disabled", "true");
  await expect(join).toHaveAttribute(
    "title",
    "Only a thread in a worktree of its own can be a workspace's worker",
  );
  // Picked anyway, it says why and the palette stays for another pick.
  await page.keyboard.type("Add to workspace");
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("toast").filter({ hasText: "Add to workspace isn't available" }),
  ).toContainText("Only a thread in a worktree of its own can be a workspace's worker");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(threadRow(page, "t-docs")).toBeVisible();

  // Pick a date library is in the web repo, which the api workspace doesn't have yet.
  palette = await openMore(page, threadRow(page, "t-question"));
  await palette.getByRole("option", { name: "Add to workspace…" }).click();
  const target = palette.getByRole("option", { name: new RegExp(`^${name}`) });
  await expect(target).toContainText("adds web");
  await target.click();
  await expect(
    page.locator('[data-testid="overview-solo"][data-thread-id="t-question"]'),
  ).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await page.evaluate(async () => (await window.gramMock!.listWorkspaces())[0]!.workspace))
          .projectIds,
    )
    .toContain("p-web");
});
