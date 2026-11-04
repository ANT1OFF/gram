import { expect, test, type Page } from "@playwright/test";

import { slowdown } from "./slowdown";
import { pressFirstWorkspaceKey } from "./thread-row";

// Tidy up in the title bar's "…", for the workspace the window is on: the board's button, in words,
// beside Workers and Pause, which a solo thread's "…" leaves out. Mock state lives in memory, so
// every step after the seed stays inside the app.

const MOCK_SETTINGS_KEY = "gram.mock.settings";

const start = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(
    ([key]) => {
      if (sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(
          key,
          JSON.stringify({
            // The default appearance is dark whatever the system says; the light shot needs it to follow.
            appearance: { mode: "system" },
            panel: { open: false },
          }),
        );
      }
    },
    [MOCK_SETTINGS_KEY] as const,
  );
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
};

const titlebar = (page: Page) => page.getByTestId("shell-titlebar");

/** Closes the title bar's "…" and the submenu open in it. */
const closeMenus = async (page: Page) => {
  const root = page.getByTestId("titlebar-overflow-menu");
  for (let i = 0; i < 2 && (await root.isVisible()); i++) await page.keyboard.press("Escape");
  await expect(root).toBeHidden();
};

/** Opens the title bar's "…", then its workspace's submenu, and resolves with its Tidy up. */
const openTidy = async (page: Page) => {
  await titlebar(page).getByTestId("titlebar-overflow").click();
  await page.getByTestId("titlebar-overflow-menu").getByTestId("menu-workspace").click();
  return page.getByTestId("titlebar-menu-workspace").getByTestId("folded-tidy");
};

test("Tidy up in the title bar says why it can't go while there is nobody to ask", async ({
  page,
}) => {
  await start(page);
  await page.evaluate(async () => {
    const mock = window.gramMock!;
    const [project] = await mock.listProjects();
    await mock.saveWorkspace({
      name: "no-orchestrator",
      projectIds: [project!.id],
      homeProjectId: project!.id,
    });
  });
  const switcher = titlebar(page).getByTestId("workspace-switcher-button");
  await expect(switcher).toHaveAttribute("data-workspaces", "1");
  // In Chat on a solo thread the window is in no workspace; Board shows the workspace's.
  await expect(switcher).toHaveText("Solo");
  // A solo thread's one bar leaves the workspace's tidy-up to Board, where the "…" has it again.
  await expect(titlebar(page).getByTestId("pane-header")).toBeVisible();
  await titlebar(page).getByTestId("titlebar-overflow").click();
  await expect(page.getByTestId("titlebar-overflow-menu")).toBeVisible();
  await expect(page.getByTestId("menu-workspace")).toHaveCount(0);
  await expect(page.getByTestId("folded-tidy")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+Alt+2");
  await expect(titlebar(page).getByTestId("view-switcher")).toBeVisible();
  await expect(switcher).toHaveText("no-orchestrator");
  const idle = await openTidy(page);
  await expect(idle).toHaveAttribute("aria-disabled", "true");
  // A disabled item shows no tooltip, so it says why in words.
  await expect(idle).toContainText("No orchestrator yet: open it first");
  await idle.click({ force: true });
  await expect(idle).not.toHaveAttribute("data-sent", /.*/);
});

test("Tidy up in the title bar asks the orchestrator, as the board's does", async ({
  page,
}, testInfo) => {
  await start(page);
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  const tidy = await openTidy(page);
  await expect(tidy).toHaveAccessibleName("Tidy up");
  await expect(tidy).not.toHaveAttribute("aria-disabled", "true");
  // Past the arrivals' motion, so both shots are still frames.
  await page.waitForTimeout(800);
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(300);
    const path = testInfo.outputPath(`titlebar-tidy-${colorScheme}.png`);
    await page.screenshot({ path });
    await testInfo.attach(`titlebar-tidy-${colorScheme}`, { path, contentType: "image/png" });
  }

  await tidy.click();
  await expect(page.getByTestId("titlebar-overflow-menu")).toBeHidden();
  // Reopened, it says it asked, and rests: a second press doesn't queue a second sweep.
  const asked = await openTidy(page);
  await expect(asked).toHaveAttribute("data-sent", /^(sent|queued)$/);
  await expect(asked).toHaveText("Asked to tidy up");
  await expect(asked).toHaveAttribute("aria-disabled", "true");
  await asked.click({ force: true });
  await closeMenus(page);
  // The cooldown passes whether the menu is open or not.
  await expect(async () => {
    const again = await openTidy(page);
    try {
      await expect(again).not.toHaveAttribute("data-sent", /.*/, { timeout: 500 });
      await expect(again).not.toHaveAttribute("aria-disabled", "true", { timeout: 500 });
    } finally {
      await closeMenus(page);
    }
  }).toPass({ timeout: 6_000 * slowdown });
  // The same message the board sends, once: an ordinary message of the user's in the thread.
  await expect(page.getByText(/^Please tidy up this workspace now/)).toHaveCount(1);
});
