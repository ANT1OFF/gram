import { basename } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { startHarness, type Harness } from "./harness";

// The Usage breakdown as the real server groups it: a live workspace is named from its stored state.
test.describe.configure({ mode: "serial" });

let h: Harness;
let page: Page;

test.beforeAll(async ({ browser }) => {
  h = await startHarness();
  page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
});

test.afterAll(async () => {
  await page?.close();
  await h?.stop();
});

const pick = (group: "Period" | "Provider", option: string) =>
  page
    .getByRole("radiogroup", { name: group, exact: true })
    .getByRole("radio", { name: option, exact: true })
    .click();

const workspaceRows = () =>
  page.getByTestId("usage-by-workspace").getByTestId("usage-breakdown-row");

test("By workspace names a live workspace, beside Solo threads, in every period and provider", async () => {
  const info = test.info();
  const solo = "Count the solo tokens";
  await h.open(page, "/new");
  await page.getByRole("combobox", { name: "Project path" }).fill(h.repo);
  await expect(page.getByTestId("folder-status")).toBeVisible();
  await page.getByRole("combobox", { name: "First prompt" }).fill(solo);
  await page.getByRole("button", { name: "Create thread" }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByText(`echo: ${solo}`)).toBeVisible();

  // New task makes the repo's workspace, named after the repo, and runs its orchestrator.
  await page.keyboard.press("ControlOrMeta+KeyN");
  await expect(page).toHaveURL(/\/new-task$/);
  await page.getByLabel("What needs doing").fill("Plan the token count");
  await page.getByRole("button", { name: /Start workspace and send/ }).click();
  await expect(page.getByTestId("pane-role")).toHaveText("Orchestrator", { timeout: 30_000 });
  await expect(page.getByTestId("transcript").getByText("echo: Plan the token count")).toBeVisible({
    timeout: 30_000,
  });
  const name = basename(h.repo);

  await h.open(page, "/usage");
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await expect(workspaceRows()).toHaveCount(2);
  const section = page.getByTestId("usage-breakdown");
  for (const mode of ["dark", "light"] as const) {
    if (mode === "light") {
      await h.open(page, "/settings/appearance");
      await page
        .getByRole("group", { name: "Mode", exact: true })
        .getByRole("button", { name: "light", exact: true })
        .click();
      await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
      await h.open(page, "/usage");
      await expect(workspaceRows()).toHaveCount(2);
    }
    await section.screenshot({ path: info.outputPath(`by-workspace-${mode}.png`) });
  }

  for (const days of ["24 h", "7 d", "30 d", "90 d"]) {
    await pick("Period", days);
    for (const provider of ["All", "Claude"]) {
      await pick("Provider", provider);
      await expect(workspaceRows()).toHaveCount(2);
      await expect(workspaceRows().first()).toContainText(name);
      await expect(workspaceRows().first()).toContainText("1 thread");
      await expect(workspaceRows().nth(1)).toContainText("Solo threads");
      await expect(workspaceRows().filter({ hasText: "Removed workspace" })).toHaveCount(0);
    }
    // The echo agent runs as Claude, so Codex has no Gram threads to group.
    await pick("Provider", "Codex");
    await expect(page.getByTestId("usage-by-workspace")).toHaveCount(0);
    await pick("Provider", "All");
  }
});
