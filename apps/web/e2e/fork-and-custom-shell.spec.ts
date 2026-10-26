import { expect, test } from "@playwright/test";

import { openMore } from "./more-menu";
import { threadRow } from "./thread-row";

test("forks a thread from the sidebar row's More…", async ({ page }) => {
  // A solo thread's header shares the title bar with the window's controls, and drops its fork
  // link and port chips when narrow: a wide window keeps them in sight.
  await page.setViewportSize({ width: 1680, height: 720 });
  await page.goto("/t/t-deps");
  const row = threadRow(page, "t-deps");
  await expect(row).toBeVisible();
  const more = await openMore(page, row);
  await more.getByRole("option", { name: "Fork thread" }).click();
  await expect(page.getByTestId("pane-header")).toContainText("Fork of");
  await expect(page.getByTestId("forked-from")).toBeVisible();
});

test("checks a custom terminal shell before saving it", async ({ page }) => {
  await page.goto("/settings/terminal");
  const terminal = page.getByTestId("terminal-settings");
  const path = terminal.getByLabel("Custom shell path");

  await path.fill("D:\\missing\\fish.exe");
  await terminal.getByRole("button", { name: "Use this shell" }).click();
  await expect(terminal.getByRole("alert")).toContainText("doesn't exist");

  await path.fill("D:\\tools\\nu.cmd");
  await terminal.getByRole("button", { name: "Use this shell" }).click();
  await expect(terminal.getByRole("status")).toHaveText("Terminals start D:\\tools\\nu.cmd.");
  const shells = terminal.getByRole("radiogroup", { name: "Windows terminal shell" });
  await expect(shells.getByRole("radio", { checked: true })).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("terminal-settings").getByLabel("Custom shell path")).toHaveValue(
    "D:\\tools\\nu.cmd",
  );
});
