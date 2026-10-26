import { expect, test, type Page } from "@playwright/test";

import { pressFirstWorkspaceKey, threadRow } from "./thread-row";

// ⌘N as a message (buildout.html "Starting work"): with an
// orchestrator on screen, ⌘N puts the caret in its composer, its draft kept; a worker still opens
// the New task draft. Mock state lives in memory, so every step after the seed stays inside the
// app.

const composer = (page: Page) => page.locator('[data-pane-root] textarea[aria-label="Message"]');

/** Focus on nothing that types, as after a click on the transcript. */
const blur = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/** The One thread scenario, on the orchestrator's home. */
const home = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.getByTestId("ask-stack")).toBeVisible();
  return made;
};

test("⌘N on the orchestrator puts the caret in its composer, keeping the draft", async ({
  page,
}) => {
  const made = await home(page);
  await composer(page).fill("Add paging to the registry list");
  await blur(page);
  await expect(composer(page)).not.toBeFocused();

  await page.keyboard.press("ControlOrMeta+KeyN");
  await expect(composer(page)).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.getByRole("form", { name: "New task" })).toHaveCount(0);
  // The caret lands at the end, so what is typed next continues the draft.
  await page.keyboard.type(" in web.");
  await expect(composer(page)).toHaveValue("Add paging to the registry list in web.");
});

test("⌘N from Board over the orchestrator comes back to Chat, in its composer", async ({
  page,
}) => {
  const made = await home(page);
  await page.keyboard.press("ControlOrMeta+Alt+2");
  await expect(page.getByTestId("view-board")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+KeyN");
  await expect(page.getByTestId("view-board")).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
});

test("⌘N on a worker still opens the New task draft", async ({ page }) => {
  const made = await home(page);
  await threadRow(page, made.asking).click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.asking}$`));

  await page.keyboard.press("ControlOrMeta+KeyN");
  await expect(page).toHaveURL(/\/new-task$/);
  await expect(page.getByRole("form", { name: "New task" })).toBeVisible();
});
