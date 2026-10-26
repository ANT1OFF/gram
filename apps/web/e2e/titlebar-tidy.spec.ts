import { expect, test, type Page } from "@playwright/test";

import { slowdown } from "./slowdown";
import { pressFirstWorkspaceKey } from "./thread-row";

// Tidy up in the title bar, for the workspace the window is on: the board's button, kept where the
// workspace name, Chat · Board and the Workers count are, which a solo thread's one bar leaves out.
// Mock state lives in memory, so every step after the seed stays inside the app.

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
  await expect(titlebar(page).getByTestId("workspace-switcher-button")).toContainText(
    "no-orchestrator",
  );
  // A solo thread's one bar leaves the workspace's tidy-up to Board, where the bar has it again.
  await expect(titlebar(page).getByTestId("pane-header")).toBeVisible();
  await expect(titlebar(page).getByTestId("titlebar-tidy")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Alt+2");
  await expect(titlebar(page).getByTestId("view-switcher")).toBeVisible();
  const idle = titlebar(page).getByTestId("titlebar-tidy");
  await expect(idle).toHaveAttribute("aria-disabled", "true");
  await expect(idle).toHaveAccessibleName("Tidy up (No orchestrator yet: open it first)");
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
  const tidy = titlebar(page).getByTestId("titlebar-tidy");
  await expect(tidy).toHaveAccessibleName("Tidy up");
  await expect(tidy).not.toHaveAttribute("aria-disabled", "true");

  // A glyph whose words are its tooltip, as on the board.
  await tidy.hover();
  const hint = page.locator('[data-slot="tooltip-content"]');
  await expect(hint).toContainText("archive what's done, fix groups, stages and plans");
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
  await expect(tidy).toHaveAttribute("data-sent", /^(sent|queued)$/);
  // A cooldown while it shows: a second press doesn't queue a second sweep.
  await expect(tidy).toHaveAttribute("aria-disabled", "true");
  await tidy.click({ force: true });
  await expect(
    titlebar(page).getByRole("status").filter({ hasText: "Asked: the orchestrator" }),
  ).toHaveCount(1);
  await expect(tidy).not.toHaveAttribute("data-sent", /.*/, { timeout: 5_000 * slowdown });
  await expect(tidy).not.toHaveAttribute("aria-disabled", "true");

  // The same message the board sends, once: an ordinary message of the user's in the thread.
  await expect(page.getByText(/^Please tidy up this workspace now/)).toHaveCount(1);
});
