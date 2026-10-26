import { expect, test } from "@playwright/test";

import { openHeaderMore } from "./more-menu";

import { openAdvancedPage } from "./settings-nav";

test("resumes a past session from /new, then marks it open", async ({ page }) => {
  await page.goto("/new");
  await page.getByRole("button", { name: "Resume a past session…" }).click();

  const sessions = page.getByTestId("resume-sessions").getByTestId("past-session");
  await expect(sessions).toHaveCount(2);
  await expect(sessions.first()).toContainText("Claude Code");
  await sessions.filter({ hasText: "Speed up the flaky retry suite" }).click();

  await expect(page).toHaveURL(/\/t\/t-/);
  await expect(page.getByTestId("pane-header")).toContainText("Speed up the flaky retry suite");

  // Client-side navigation keeps the mock's state, so the resumed thread still exists.
  await page.keyboard.press("ControlOrMeta+KeyT");
  await page.getByRole("button", { name: "Resume a past session…" }).click();
  await expect(sessions.filter({ hasText: "Speed up the flaky retry suite" })).toContainText(
    "Open",
  );
});

test("applies keybinding overrides, flags a clash and resets one", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("gram.mock.keybindings")) {
      sessionStorage.setItem(
        "gram.mock.keybindings",
        JSON.stringify({ "sidebar.toggle": "mod+shift+b", "panel.toggle": "mod+shift+b" }),
      );
    }
  });
  await page.goto("/t/t-deps");
  await expect(page.getByTestId("right-panel")).toBeVisible();
  // Let the overrides load before pressing keys.
  await page.waitForTimeout(500);
  await page.keyboard.press("ControlOrMeta+Shift+b");
  await expect(page.getByTestId("right-panel")).toBeHidden();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await openAdvancedPage(page, "Keyboard");
  const settings = page.getByTestId("keyboard-settings");
  const sidebarRow = settings.getByTestId("binding-sidebar.toggle");
  await expect(sidebarRow).toContainText("custom");
  await expect(sidebarRow).toContainText("Same keys as Show / hide right panel");

  await sidebarRow.getByRole("button", { name: /^Reset / }).click();
  await expect(sidebarRow).not.toContainText("custom");
  await expect(sidebarRow).toContainText(/⌘B|Ctrl\+B/);
  await expect(settings.getByTestId("binding-panel.toggle")).not.toContainText("Same keys");
});

const WORKTREE = "/Users/dev/code/api/.worktrees/fix-flaky-retry";
const RETRY = `${WORKTREE}/src/retry.ts`;
/** The diff's first file: the editor is handed it relative to the thread, the file manager whole. */
const DIFF_ROW = expect.stringMatching(/^(\/.+\/)?assets\/retry-timeline\.png$/);

test("opens a previewed file, a diff row and the thread folder in the editor", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  const toasts = page.getByTestId("toast").filter({ hasText: "Opening in VS Code" });
  // Toasts expire, so what was opened is read from the mock's calls, not from what's on screen.
  const opened = () => page.evaluate(() => window.gramMock?.editorOpens.map((open) => open.path));

  await panel.getByRole("tab", { name: "Files", exact: true }).click();
  const tree = panel
    .getByTestId("files-tree-pane")
    .getByRole("tree", { name: "Files", exact: true });
  await tree.getByRole("treeitem", { name: "src", exact: true }).click();
  await tree.getByRole("treeitem", { name: "retry.ts", exact: true }).click();
  await panel.getByTestId("file-preview").getByRole("button", { name: "Open in editor" }).click();
  await expect(toasts.filter({ hasText: "retry.ts" })).toBeVisible();
  await expect.poll(opened).toEqual([RETRY]);

  await panel.getByRole("tab", { name: "Diff", exact: true }).click();
  await panel
    .getByRole("button", { name: /^Open .* in editor$/ })
    .first()
    .click();
  await expect.poll(opened).toEqual([RETRY, DIFF_ROW]);

  await page.getByRole("button", { name: "Thread menu" }).first().click();
  await page.getByRole("menuitem", { name: "Open folder in editor" }).click();
  await expect.poll(opened).toEqual([RETRY, DIFF_ROW, WORKTREE]);
});

test("reveals a previewed file, a diff row and the thread folder in the file manager", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  const toasts = page.getByTestId("toast").filter({ hasText: "Showing in Finder" });
  const reveal = /^(Reveal|Show) (.+ )?in (Finder|Explorer|file manager)$/;
  const revealed = () => page.evaluate(() => window.gramMock?.reveals.map((shown) => shown.path));

  await panel.getByRole("tab", { name: "Files", exact: true }).click();
  const tree = panel
    .getByTestId("files-tree-pane")
    .getByRole("tree", { name: "Files", exact: true });
  await tree.getByRole("treeitem", { name: "src", exact: true }).click();
  await tree.getByRole("treeitem", { name: "retry.ts", exact: true }).click();
  await panel.getByTestId("file-preview").getByRole("button", { name: reveal }).click();
  await expect(toasts.filter({ hasText: "retry.ts" })).toBeVisible();
  await expect.poll(revealed).toEqual([RETRY]);

  await panel.getByRole("tab", { name: "Diff", exact: true }).click();
  await panel.getByRole("button", { name: reveal }).first().click();
  await expect.poll(revealed).toEqual([RETRY, DIFF_ROW]);

  const more = await openHeaderMore(page);
  await more.getByRole("option", { name: reveal }).click();
  await expect.poll(revealed).toEqual([RETRY, DIFF_ROW, WORKTREE]);
});
