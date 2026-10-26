import { expect, test } from "@playwright/test";

import { terminalText } from "./terminal";

test("browses the checkout and previews a file in the Files tab", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Files", exact: true }).click();

  // The Diff tab's tree is named Files too, and lingers while its tab fades out.
  const tree = panel.getByTestId("files-tree-pane").getByRole("tree", { name: "Files" });
  await tree.getByRole("treeitem", { name: "src", exact: true }).click();
  await tree.getByRole("treeitem", { name: "retry.ts", exact: true }).click();

  const preview = panel.getByTestId("file-preview");
  await expect(preview).toContainText("export async function retry");

  await preview.getByRole("button", { name: "Close preview" }).focus();
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(tree.getByRole("treeitem", { name: "retry.ts", exact: true })).toBeFocused();

  await tree.getByRole("treeitem", { name: "docs", exact: true }).click();
  await tree.getByRole("treeitem", { name: "font.woff2", exact: true }).click();
  await expect(panel.getByTestId("file-preview")).toContainText("Binary file");

  await tree.getByRole("treeitem", { name: "architecture.md", exact: true }).click();
  const markdown = panel.getByTestId("markdown-preview");
  await expect(markdown.getByTestId("checkout-image")).toHaveCount(2);
  await markdown.getByRole("link", { name: "retry", exact: true }).click();
  await expect(panel.getByTestId("file-preview")).toContainText("export async function retry");

  await tree.getByRole("treeitem", { name: "diagram.svg", exact: true }).click();
  await expect(panel.getByTestId("checkout-image")).toHaveAttribute(
    "src",
    /^data:image\/svg\+xml;base64,/,
  );
  expect(await page.evaluate(() => Reflect.get(window, "__svgScriptRan"))).toBeUndefined();
});

test("drags the split between the file tree and the preview, and keeps it after a reload", async ({
  page,
}) => {
  const openRetry = async () => {
    const panel = page.getByTestId("right-panel");
    await panel.getByRole("tab", { name: "Files", exact: true }).click();
    const tree = panel
      .getByTestId("files-tree-pane")
      .getByRole("tree", { name: "Files", exact: true });
    const retry = tree.getByRole("treeitem", { name: "retry.ts", exact: true });
    if (!(await retry.isVisible()))
      await tree.getByRole("treeitem", { name: "src", exact: true }).click();
    await retry.click();
    await expect(panel.getByTestId("file-preview")).toContainText("export async function retry");
    return panel.getByRole("separator", { name: "Resize file tree" });
  };

  await page.goto("/t/t-flaky");
  const split = await openRetry();
  await expect(split).toHaveAttribute("aria-valuenow", "40");
  const box = await split.boundingBox();
  if (box === null) throw new Error("the split has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 120, { steps: 5 });
  await page.mouse.up();
  const dragged = Number(await split.getAttribute("aria-valuenow"));
  expect(dragged).toBeGreaterThan(40);

  await page.reload();
  const after = await openRetry();
  await expect(after).toHaveAttribute("aria-valuenow", String(dragged));
  await after.dblclick();
  await expect(after).toHaveAttribute("aria-valuenow", "40");
});

test("types in the Terminal tab, sees the echo, and app shortcuts still work", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Terminal", exact: true }).click();

  const terminal = panel.getByTestId("terminal").first();
  const rows = terminalText(terminal);
  await expect(rows).toContainText("$", { timeout: 15_000 });
  await terminal.getByTestId("terminal-surface").click();
  await page.keyboard.type("ls");
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("echo: ls");

  // ⌘B hides the overview's sidebar, which the window shows open.
  const overview = page.getByTestId("overview-sidebar");
  await expect(overview).toBeVisible();
  await page.keyboard.press("ControlOrMeta+b");
  if (process.platform === "darwin") {
    await expect(overview).toHaveCount(0);
    return;
  }
  // Off macOS a plain Ctrl chord is the shell's own (Ctrl+B steps the cursor back), so the app
  // answers only Ctrl+Shift and Ctrl+Alt chords from a focused terminal.
  await page.keyboard.press("ControlOrMeta+Alt+KeyS");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest("[data-overview]") != null))
    .toBe(true);
  await expect(overview).toBeVisible();
});
