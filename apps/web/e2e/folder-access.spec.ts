import { expect, test } from "@playwright/test";

import { clipboardText } from "./clipboard";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("a folder the system won't let Gram read shows the recovery card", async ({ page }) => {
  await page.goto("/new");
  const path = page.getByRole("combobox", { name: "Project path" });
  await path.fill("~/Documents/Private");

  const card = page.getByTestId("folder-access-recovery");
  await expect(card.getByRole("alert")).toHaveText("Gram can't read this folder");
  await expect(card).toContainText("/Users/dev/Documents/Private");
  await expect(card).toContainText("Privacy & Security → Files & Folders");
  await expect(page.getByRole("button", { name: /Create thread/ })).toBeDisabled();
  // The browser dev build has no desktop bridge: no Privacy Settings shortcut, no native dialog.
  await expect(card.getByRole("button", { name: "Open Privacy Settings" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose folder…" })).toHaveCount(0);

  await card.getByRole("button", { name: "Retry" }).click();
  await expect(card).toContainText("/Users/dev/Documents/Private");

  await card.getByRole("button", { name: "Copy diagnostic details" }).click();
  await expect(card.getByRole("status")).toHaveText("Copied diagnostic details.");
  await expect
    .poll(() => clipboardText(page))
    .toBe(
      [
        "Gram folder access",
        "Path: /Users/dev/Documents/Private",
        "Error: EPERM",
        "Platform: browser",
        "App: not the desktop app",
      ].join("\n"),
    );
});

test("the folder browser offers recovery for a denied folder", async ({ page }) => {
  await page.goto("/new");
  await page.getByRole("combobox", { name: "Project path" }).fill("~/Documents/");
  // Browse opens at the checked folder, so wait for the check before opening it.
  await expect(page.getByTestId("folder-status")).toContainText("~/Documents");
  await page.getByRole("button", { name: "Browse" }).click();
  await page
    .getByRole("listbox", { name: "Folders" })
    .getByRole("option", { name: "Private" })
    .dblclick();

  const browser = page.getByTestId("folder-browser");
  const card = browser.getByTestId("folder-access-recovery");
  await expect(card).toContainText("/Users/dev/Documents/Private");
  await expect(card.getByRole("button", { name: "Retry" })).toBeEnabled();
});
