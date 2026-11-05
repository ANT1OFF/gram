import { expect, test } from "@playwright/test";

import { openSettingsPage } from "./settings-nav";

const PATH = /Application Support\/Gram\/keybindings\.json$/;

test("searches shortcuts, filters by group and clash, and keeps the file's path behind help", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("gram.mock.keybindings")) {
      sessionStorage.setItem(
        "gram.mock.keybindings",
        JSON.stringify({ "sidebar.toggle": "mod+shift+b", "panel.toggle": "mod+shift+b" }),
      );
    }
  });
  await page.goto("/t/t-deps");
  await expect(page.getByTestId("pane-header")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await openSettingsPage(page, "Keyboard");
  const settings = page.getByTestId("keyboard-settings");
  const palette = settings.getByTestId("binding-palette.open");
  const sidebar = settings.getByTestId("binding-sidebar.toggle");
  const panel = settings.getByTestId("binding-panel.toggle");
  const send = settings.getByTestId("binding-composer.send");
  await expect(sidebar).toContainText("custom");

  // The intro is one short line; the full path waits behind the help next to it.
  const intro = settings.getByTestId("keyboard-intro");
  await expect(intro).toContainText("Or edit them all in keybindings.json.");
  await expect(intro).not.toContainText("Application Support");
  await settings.getByRole("button", { name: "Where keybindings.json lives" }).click();
  const help = page.getByTestId("keyboard-file-help-popup");
  await expect(help.getByTestId("keyboard-path")).toHaveText(PATH);
  await expect(help.getByRole("button", { name: "Copy path" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await expect(page).toHaveURL(/\/settings\/keyboard$/);

  // A search finds a shortcut by its name or by its keys, however they're written.
  const search = settings.getByRole("searchbox", { name: "Search shortcuts" });
  await expect(search).not.toBeFocused();
  for (const query of ["command palette", "⌘K", "cmd k", "mod+k"]) {
    await search.fill(query);
    await expect(palette, query).toBeVisible();
    await expect(sidebar, query).toBeHidden();
  }
  // Groups with nothing left hide.
  await expect(settings.getByRole("region", { name: "App", exact: true })).toBeVisible();
  await expect(settings.getByRole("region", { name: "Terminal", exact: true })).toBeHidden();

  await search.fill("zzzz");
  await expect(settings.getByTestId("keyboard-filter-empty")).toHaveText(
    "No shortcuts match “zzzz”.",
  );

  // Esc clears the field before it can leave Settings; from empty it steps out of the field.
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page).toHaveURL(/\/settings\/keyboard$/);
  await expect(palette).toBeVisible();
  await expect(sidebar).toBeVisible();

  // One group at a time.
  const composer = settings.getByRole("button", { name: "Composer", exact: true });
  await composer.click();
  await expect(composer).toHaveAttribute("aria-pressed", "true");
  await expect(send).toBeVisible();
  await expect(palette).toBeHidden();
  await settings.getByRole("button", { name: "All", exact: true }).click();
  await expect(composer).toHaveAttribute("aria-pressed", "false");
  await expect(palette).toBeVisible();

  // Only the clashing bindings, counted on the chip.
  const conflicts = settings.getByRole("button", { name: "Conflicts, 2" });
  await expect(conflicts).toHaveAttribute("aria-pressed", "false");
  await conflicts.click();
  await expect(conflicts).toHaveAttribute("aria-pressed", "true");
  await expect(sidebar).toBeVisible();
  await expect(panel).toBeVisible();
  await expect(palette).toBeHidden();
  await expect(send).toBeHidden();
  await conflicts.click();
  await expect(palette).toBeVisible();

  // Settings search (⌘F) still filters the rows itself, without this page's own filter.
  await conflicts.click();
  await page.keyboard.press("ControlOrMeta+f");
  const settingsSearch = page.getByRole("textbox", { name: "Search settings" });
  await expect(settingsSearch).toBeFocused();
  await settingsSearch.fill("command palette");
  await expect(palette).toBeVisible();
  await expect(sidebar).toBeHidden();
  await expect(search).toBeHidden();
  await settingsSearch.press("Escape");
  await expect(search).toBeVisible();
  await expect(palette).toBeHidden();
  await expect(sidebar).toBeVisible();
});
