import { expect, test } from "@playwright/test";

import { openLayout } from "./layout";
import { openOrchestrator } from "./thread-row";
import { openMoreOptions } from "./new-thread-options";

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
  // The title bar's Layout marks it as the layout.
  await openLayout(page);
  await expect(
    page.getByTestId("folded-layout").getByRole("menuitemradio", { name: "2×2", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");

  // Project picks in the palette now open a new thread on that project's path.
  await page.keyboard.press("ControlOrMeta+k");
  await query.fill("docs");
  await palette
    .getByRole("group", { name: "Projects", exact: true })
    .getByRole("option", { name: /^docs/ })
    .click();
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(/\/new$/);
  await openMoreOptions(page);
  await expect(page.getByRole("combobox", { name: "Project path" })).toHaveValue(/docs/);
});

test("a ⌘K jump to a solo thread says Solo in the header, opens Solo threads and marks its row", async ({
  page,
}) => {
  // The realistic morning on its "Gram" orchestrator, Solo threads folded as a working window's.
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.orchestration", "realistic");
    localStorage.setItem(
      "gram.layout",
      JSON.stringify({ version: 1, state: { overviewFolded: ["solo"] } }),
    );
  });
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  const made = await page.evaluate(async () => {
    const started = await window.gramMock!.startedRealistic();
    if (started === undefined)
      throw new Error("the mock did not start with the realistic scenario");
    return started;
  });
  await openOrchestrator(page, made.orchestratorThreadId);
  const switcher = page.getByTestId("workspace-switcher-button");
  await expect(switcher).toHaveText("Gram");
  const sidebar = page.getByTestId("overview-sidebar");
  const soloTitle = sidebar.getByTestId("overview-section-solo").getByRole("button").first();
  await expect(soloTitle).toHaveAttribute("aria-expanded", "false");
  const gram = sidebar.locator(
    `[data-workspace-id="${made.workspaceId}"] [data-testid="overview-workspace-row"]`,
  );
  await expect(gram).toHaveAttribute("aria-current", "true");

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette").getByRole("combobox").fill("Bump dependencies");
  await page.getByRole("option", { name: /Bump dependencies/ }).click();
  await expect(page).toHaveURL(/\/t\/t-deps$/);

  // Where it landed: the header names Solo, its section opens, and its row is the marked one.
  await expect(switcher).toHaveText("Solo");
  await expect(soloTitle).toHaveAttribute("aria-expanded", "true");
  const row = sidebar.locator('[data-testid="overview-solo"][data-thread-id="t-deps"]');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(gram).not.toHaveAttribute("aria-current");
  await expect(sidebar.locator('[aria-current="true"]')).toHaveCount(1);

  // Folding it again while there keeps it folded; jumping back to a worker marks its workspace.
  await soloTitle.click();
  await expect(soloTitle).toHaveAttribute("aria-expanded", "false");
  await page.waitForTimeout(300);
  await expect(soloTitle).toHaveAttribute("aria-expanded", "false");
  await openOrchestrator(page, made.orchestratorThreadId);
  await expect(switcher).toHaveText("Gram");
  await expect(gram).toHaveAttribute("aria-current", "true");
});
