import { expect, test, type Page } from "@playwright/test";

import { seedTheme } from "./seed-theme";
import { slowdown } from "./slowdown";

/** Drags the right panel's edge by `dx` (negative widens it). */
async function dragPanelEdge(page: Page, dx: number) {
  const handle = page.getByTestId("right-resize");
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

/** Milliseconds from a click on `selector` to the second frame after it, as the user waits. */
const timeClick = (page: Page, selector: string) =>
  page.evaluate(async (css) => {
    const target = document.querySelector<HTMLElement>(css)!;
    const start = performance.now();
    target.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - start;
  }, selector);

test("the file tree jumps to a file, and n / p step through its hunks", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("diff-panel");
  // A narrow panel leaves the files to their list; the tree takes its place beside it once wider.
  await expect(panel.getByTestId("diff-file").first()).toBeVisible();
  await expect(panel.getByRole("tree")).toHaveCount(0);
  await dragPanelEdge(page, -420);
  const tree = panel.getByRole("tree", { name: "Changed files" });
  await expect(tree.getByRole("treeitem")).toHaveCount(8);
  await expect(tree.getByRole("treeitem", { name: "src" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  await tree.getByRole("treeitem", { name: "retry.test.ts" }).click();
  const retry = panel.locator("[data-testid='diff-file'][data-path='src/retry.test.ts']");
  await expect(retry.locator("[data-diff-file-header]")).toHaveAttribute("aria-expanded", "true");

  // n goes on to the file's first hunk, then into the lockfile after it; p comes back.
  await page.keyboard.press("n");
  await expect(retry.locator("[data-hunk='0']")).toHaveAttribute("data-current", "true");
  await page.keyboard.press("n");
  const lockfile = panel.locator("[data-testid='diff-file'][data-path='pnpm-lock.yaml']");
  await expect(lockfile.locator("[data-hunk='0']")).toHaveAttribute("data-current", "true");
  await expect(lockfile.locator("[data-hunk='0']")).toBeInViewport();
  await page.keyboard.press("p");
  await expect(retry.locator("[data-hunk='0']")).toHaveAttribute("data-current", "true");

  // Typing in the composer is typing, not stepping.
  await page.getByRole("combobox", { name: "Message" }).fill("");
  await page.getByRole("combobox", { name: "Message" }).press("n");
  await expect(page.getByRole("combobox", { name: "Message" })).toHaveValue("n");
  await expect(retry.locator("[data-hunk='0']")).toHaveAttribute("data-current", "true");

  // The tree hides, and stays hidden across a reload.
  await panel.getByRole("button", { name: "File tree" }).click();
  await expect(tree).toHaveCount(0);
  await page.reload();
  await expect(panel.getByTestId("diff-file").first()).toBeVisible();
  await expect(panel.getByRole("button", { name: "File tree" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(panel.getByRole("tree")).toHaveCount(0);
});

test("split view shows old and new side by side once the panel is wide enough", async ({
  page,
}) => {
  await page.goto("/t/t-docs");
  const panel = page.getByTestId("diff-panel");
  await expect(panel.getByTestId("patch")).toBeVisible();

  await panel.getByRole("radio", { name: "Split" }).click();
  // The default panel is too narrow: unified it stays, and the toggle says why.
  await expect(panel).toHaveAttribute("data-layout", "unified");
  await expect(panel.getByRole("radio", { name: "Split" })).toHaveAttribute("title", /wider/);

  await dragPanelEdge(page, -320);
  await expect(panel).toHaveAttribute("data-layout", "split");
  const patch = panel.getByTestId("patch");
  await expect(patch).toHaveAttribute("data-layout", "split");
  // `# Install` → `# Getting started` sit on one row; the two added lines after it have no old side.
  const first = patch.locator("tr[data-kind='change']").first();
  await expect(first.locator("td[data-kind='del']").last()).toHaveText("# Install");
  await expect(first.locator("td[data-kind='add']").last()).toHaveText("# Getting started");
  await expect(patch.locator("td[data-side='blank']")).toHaveCount(2);

  await page.reload();
  await expect(panel).toHaveAttribute("data-layout", "split");

  // Narrowed again, it drops back to unified, and returns to split when widened.
  await dragPanelEdge(page, 320);
  await expect(panel).toHaveAttribute("data-layout", "unified");
  await panel.getByRole("radio", { name: "Unified" }).click();
  await dragPanelEdge(page, -320);
  await expect(panel).toHaveAttribute("data-layout", "unified");
});

test("a 2,752-line lockfile opens without holding up the panel", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("diff-panel");
  const lockfile = panel.locator("[data-testid='diff-file'][data-path='pnpm-lock.yaml']");
  await expect(lockfile).toBeVisible();
  // Collapsed, it renders nothing.
  await expect(lockfile.locator("tr")).toHaveCount(0);

  const opened = await timeClick(
    page,
    "[data-testid='diff-file'][data-path='pnpm-lock.yaml'] [data-diff-file-header]",
  );
  await expect(lockfile.locator("tr")).toHaveCount(400);
  const all = await timeClick(
    page,
    "[data-testid='diff-file'][data-path='pnpm-lock.yaml'] [data-testid='patch'] > button",
  );
  await expect(lockfile.locator("tr")).toHaveCount(16 * 179);
  console.log(`lockfile: first 400 rows ${opened.toFixed(0)} ms, all rows ${all.toFixed(0)} ms`);
  expect(opened).toBeLessThan(500 * slowdown);
  expect(all).toBeLessThan(1500 * slowdown);
});

for (const motion of ["system", "reduced"] as const) {
  test(`a collapsed lockfile lets go of its rows with motion ${motion}`, async ({ page }) => {
    await seedTheme(page, { palette: "tokyo-night", mode: "dark", motion });
    await page.goto("/t/t-flaky");
    const lockfile = page.locator("[data-testid='diff-file'][data-path='pnpm-lock.yaml']");
    const header = lockfile.locator("[data-diff-file-header]");
    await header.click();
    await lockfile.getByRole("button", { name: /^Show .* more lines$/ }).click();
    await expect(lockfile.locator("tr")).toHaveCount(16 * 179);
    await header.click();
    await expect(lockfile.locator("tr")).toHaveCount(0);
  });
}

test("lines picked in the diff become a comment the next message carries", async ({ page }) => {
  await page.goto("/t/t-docs");
  const panel = page.getByTestId("diff-panel");
  const patch = panel.getByTestId("patch");
  await expect(patch).toBeVisible();

  await patch.locator("[data-gutter='0:1']").first().click();
  await patch
    .locator("[data-gutter='0:3']")
    .first()
    .click({ modifiers: ["Shift"] });
  await expect(patch.locator("td[data-picked]")).toHaveCount(6);
  await patch.locator("tr[data-line='0:2'] td").last().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Comment on lines 1-3" }).click();
  const editor = panel.getByRole("textbox", { name: "Comment on lines 1-3" });
  await editor.fill("Say where to run it.");
  await editor.press("ControlOrMeta+Enter");

  const chip = page.getByTestId("diff-comment-chip");
  await expect(chip).toHaveText(/README\.md:1-3/);
  const note = panel.getByTestId("diff-comment");
  await expect(note).toContainText("Say where to run it.");

  // Right-click edits the draft in place.
  await note.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit comment" }).click();
  const edit = panel.getByRole("textbox", { name: "Comment on lines 1-3" });
  await edit.fill("Say where to run it, and with which Node.");
  await panel.getByRole("button", { name: /^Save/ }).click();
  await expect(note).toContainText("which Node");

  const composer = page.getByRole("combobox", { name: "Message" });
  await composer.fill("Then push.");
  // The mock README turn autoplays: a fast run otherwise queues this instead of sending it.
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeVisible({ timeout: 15_000 * slowdown });
  await send.click();
  await expect(chip).toHaveCount(0);
  await expect(note).toHaveCount(0);
  // The user's message, not the echo quoting its first line back.
  const sent = page
    .getByTestId("message-user")
    .filter({ hasText: "A review comment on the diff:" });
  await expect(sent).toHaveCount(1);
  await expect(sent).toContainText("README.md:1-3");
  await expect(sent).toContainText("Then push.");
});
