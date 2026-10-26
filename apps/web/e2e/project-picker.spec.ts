import { expect, test } from "@playwright/test";

import { seedTheme } from "./seed-theme";

// Dark with system (full) motion, light with motion off: the picker must work in both.
for (const { mode, motion, resolved } of [
  { mode: "dark", motion: "system", resolved: "full" },
  { mode: "light", motion: "off", resolved: "off" },
] as const) {
  test(`browses to a repo, chooses it and creates a thread (${mode}, motion ${motion})`, async ({
    page,
  }) => {
    await seedTheme(page, { palette: "tokyo-night", mode, motion });
    await page.goto("/new");
    await expect(page.locator("html")).toHaveAttribute("data-mode", mode);

    const path = page.getByRole("combobox", { name: "Project path" });
    await path.fill("~/Documents/co");
    await expect(page.getByRole("option", { name: "code" })).toBeVisible();
    await path.press("Tab");
    await expect(path).toHaveValue("~/Documents/code/");

    await page.getByRole("button", { name: "Browse" }).click();
    const repo = page.getByRole("listbox", { name: "Folders" }).getByRole("option", {
      name: /gram/,
    });
    await expect(repo).toContainText("git");
    await repo.dblclick();
    await expect(
      page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("button", {
        name: "gram",
      }),
    ).toHaveAttribute("aria-current", "location");
    await page.getByRole("button", { name: "Choose this folder" }).click();

    await expect(path).toHaveValue("~/Documents/code/gram");
    await expect(page.getByTestId("folder-status")).toContainText("git");

    await page.getByLabel("First prompt").fill("hello from the picker");
    await page.getByRole("button", { name: /Create thread/ }).click();
    await expect(page).toHaveURL(/\/t\/t-mock-/);
    // By now the server's settings have loaded; they must not have replaced the seed.
    await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
    await expect(page.locator("html")).toHaveAttribute("data-motion", resolved);
  });
}

test("blocks Create until the path is a real folder", async ({ page }) => {
  await page.goto("/new");
  const path = page.getByRole("combobox", { name: "Project path" });
  await path.fill("~/Documents/nope");
  await expect(page.getByTestId("folder-problem")).toHaveText(
    "Folder not found: /Users/dev/Documents/nope",
  );
  await expect(page.getByRole("button", { name: /Create thread/ })).toBeDisabled();
});
