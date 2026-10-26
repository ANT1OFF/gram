import { expect, test } from "@playwright/test";
import { threadRow } from "./thread-row";

test("Ctrl+Tab switches to the last thread once Ctrl is released", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await expect(page.getByTestId("pane-header")).toContainText("Fix flaky retry test");
  await threadRow(page, "t-question").click();
  await expect(page).toHaveURL(/\/t\/t-question/);
  await expect(page.getByTestId("pane-header")).toContainText("Pick a date library");

  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  const switcher = page.getByTestId("thread-switcher");
  const selected = switcher.locator('[aria-current="true"]');
  await expect(switcher).toBeVisible();
  await expect(selected).toContainText("Fix flaky retry test");
  await page.keyboard.press("Tab");
  await expect(selected).not.toContainText("Fix flaky retry test");
  await page.keyboard.press("Shift+Tab");
  await expect(selected).toContainText("Fix flaky retry test");
  await page.keyboard.up("Control");

  await expect(switcher).toBeHidden();
  await expect(page).toHaveURL(/\/t\/t-flaky/);
  await expect(page.getByTestId("pane-header")).toContainText("Fix flaky retry test");
});

test("⌘⇧T reopens the thread just closed, with its conversation", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await expect(page.getByTestId("pane-header")).toContainText("Fix flaky retry test");
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByTestId("message-user").first()).toContainText(
    "Make the retry test deterministic",
  );
  await page.keyboard.press("ControlOrMeta+Alt+w");
  await page
    .getByTestId("close-thread-dialog")
    .getByRole("button", { name: "Close thread", exact: true })
    .click();
  await expect(threadRow(page, "t-flaky")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+Shift+t");
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
  await expect(page.getByTestId("pane-header")).toContainText("Fix flaky retry test");
  await expect(transcript.getByTestId("message-user").first()).toContainText(
    "Make the retry test deterministic",
  );
});

test("⌘⇧T still reaches a thread closed before a reload", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await expect(page.getByTestId("pane-header")).toContainText("Fix flaky retry test");
  await page.keyboard.press("ControlOrMeta+Alt+w");
  await page
    .getByTestId("close-thread-dialog")
    .getByRole("button", { name: "Close thread", exact: true })
    .click();
  await expect(threadRow(page, "t-flaky")).toHaveCount(0);

  await page.reload();
  await expect(threadRow(page, "t-docs")).toBeVisible();
  await expect(threadRow(page, "t-flaky")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+t");
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
  await expect(page.getByTestId("pane-header")).toContainText("Fix flaky retry test");
});

test("⌘T drafts a new thread in the current thread's folder", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await expect(page.getByTestId("pane-header")).toContainText("Fix flaky retry test");
  await page.keyboard.press("ControlOrMeta+t");
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole("combobox", { name: "Project path" })).toHaveValue(/^\/Users\/dev\//);
});
