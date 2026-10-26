import { expect, test } from "@playwright/test";

test("layout preset keys, an empty pane's quick open, and a project's new thread", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  const grid = page.getByTestId("thread-grid");
  const panes = page.getByTestId("pane");
  // The shortcuts register once the shell has mounted.
  await expect(page.getByTestId("pane-header")).toBeVisible();

  // Ctrl+Shift+N on every platform: ⌘⇧3–5 belong to macOS screenshots.
  await page.keyboard.press("Control+Shift+Digit3");
  await expect(grid).toHaveAttribute("data-preset", "3c");
  await expect(panes).toHaveCount(3);

  const offered = panes.nth(1).getByRole("region", { name: "Open a thread here" });
  // The quick list offers only six recent threads that aren't already on screen.
  await expect(offered.getByRole("button")).toHaveCount(6);
  await expect(offered.getByRole("button", { name: /Release checklist/ })).toHaveCount(0);
  await offered.getByRole("button", { name: /Rewrite the README/ }).click();
  await expect(panes.nth(1)).toHaveAttribute("data-thread-id", "t-docs");
  await expect(page).toHaveURL(/\/t\/t-docs$/);
  await expect(panes.nth(0)).toHaveAttribute("data-thread-id", "t-deps");

  // An older thread is still searchable, and opens in the same focused second pane.
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  const query = palette.getByRole("combobox", { name: "Go to, or > for commands" });
  await query.fill("Release checklist");
  await palette
    .getByRole("group", { name: "Threads", exact: true })
    .getByRole("option", { name: /Release checklist/ })
    .click();
  await expect(palette).toBeHidden();
  await expect(panes.nth(1)).toHaveAttribute("data-thread-id", "t-release");
  await expect(panes.nth(0)).toHaveAttribute("data-thread-id", "t-deps");
  await expect(page).toHaveURL(/\/t\/t-release$/);

  await page.keyboard.press("Control+Shift+Digit4");
  await expect(grid).toHaveAttribute("data-preset", "2x2");
  await expect(page.getByRole("button", { name: "Layout: 2×2", exact: true })).toBeVisible();

  // Project picks in the palette now open a new thread on that project's path.
  await page.keyboard.press("ControlOrMeta+k");
  await query.fill("docs");
  await palette
    .getByRole("group", { name: "Projects", exact: true })
    .getByRole("option", { name: /^docs/ })
    .click();
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole("combobox", { name: "Project path" })).toHaveValue(/docs/);
});
