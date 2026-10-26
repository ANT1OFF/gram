import { expect, test, type Page } from "@playwright/test";

import { startHarness, type Harness } from "./harness";

let h: Harness;
let page: Page;

test.beforeAll(async ({ browser }) => {
  h = await startHarness();
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page?.close();
  await h?.stop();
});

test("a thread's usage comes back after a server restart and a reload", async () => {
  const prompt = "Count the tokens";
  await h.open(page, "/new");
  await page.getByRole("combobox", { name: "Project path" }).fill(h.repo);
  await expect(page.getByTestId("folder-status")).toBeVisible();
  await page.getByRole("combobox", { name: "First prompt" }).fill(prompt);
  await page.getByRole("button", { name: "Create thread" }).click();

  await expect(page).toHaveURL(/\/t\/[^/]+$/, { timeout: 30_000 });
  const threadPath = new URL(page.url()).pathname;
  await expect(page.getByText(`echo: ${prompt}`)).toBeVisible();
  // The echo agent reports token counts without the context, so the ring shows only once usage is
  // in, and opens onto the context not being reported.
  await page.getByTestId("usage-ring").click();
  await expect(page.getByTestId("usage")).toContainText("Context not reported yet");

  // A restart drops every live session: the thread is cold, and the bar shows the persisted usage.
  await h.restart();
  await h.open(page, threadPath);
  await expect(page.getByText(`echo: ${prompt}`)).toBeVisible();
  await page.getByTestId("usage-ring").click();
  await expect(page.getByTestId("usage")).toContainText("Context not reported yet");
});
