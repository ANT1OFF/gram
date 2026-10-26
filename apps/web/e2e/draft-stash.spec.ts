import { expect, test } from "@playwright/test";

test("⌘S stashes a draft that survives a reload and comes back with a click", async ({ page }) => {
  await page.goto("/t/t-release");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("a half-finished thought");
  await composer.press("ControlOrMeta+s");

  await expect(composer).toHaveValue("");
  const trigger = page.getByTestId("stash-trigger");
  await expect(trigger).toHaveAccessibleName("Stashed drafts (1)");

  await page.reload();
  await expect(trigger).toHaveAccessibleName("Stashed drafts (1)");

  // Restoring over a draft stashes that one first, so nothing is lost.
  await composer.fill("something new");
  await trigger.click();
  await page
    .getByTestId("stash-menu")
    .getByRole("button", { name: "Restore draft: a half-finished thought" })
    .click();
  await expect(composer).toHaveValue("a half-finished thought");
  await expect(trigger).toHaveAccessibleName("Stashed drafts (1)");

  await trigger.click();
  const menu = page.getByTestId("stash-menu");
  await expect(menu).toContainText("something new");
  await menu.getByRole("button", { name: "Discard draft: something new" }).click();
  await expect(trigger).toBeHidden();
});

test("⌘S doesn't stash while focus is outside the composer", async ({ page }) => {
  await page.goto("/t/t-release");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("stay put");
  await page
    .getByTestId("overview-sidebar")
    .getByRole("button", { name: "New", exact: true })
    .focus();
  await page.keyboard.press("ControlOrMeta+s");

  await expect(composer).toHaveValue("stay put");
  await expect(page.getByTestId("stash-trigger")).toBeHidden();
});
