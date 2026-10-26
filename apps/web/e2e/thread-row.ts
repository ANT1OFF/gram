import { expect, type Page } from "@playwright/test";

/**
 * A thread's row in the overview sidebar: a solo thread under Solo threads (a parked one once its
 * Parked line is open), or a live worker of the workspace the window is on. A click opens the
 * thread, a right-click its menu, and it drags onto a grid pane.
 */
export const threadRow = (page: Page, threadId: string) =>
  page
    .getByTestId("overview-sidebar")
    .locator(
      `:is([data-testid="overview-solo"], [data-testid="overview-worker"])[data-thread-id="${threadId}"]`,
    );

/**
 * Opens a workspace's orchestrator from its row in the overview, as a user would: by the
 * orchestrator's thread id, which is what the mock's scenarios return. Nothing reloads, so a
 * scenario seeded in memory stays. The row's own button is the one without a test id: what is at
 * work there has its line under it.
 */
export async function openOrchestrator(page: Page, orchestratorThreadId: string): Promise<void> {
  const workspaceId = await page.evaluate(
    async (id) =>
      (await window.gramMock!.listWorkspaces()).find(
        (state) => state.workspace.orchestratorThreadId === id,
      )?.workspace.id,
    orchestratorThreadId,
  );
  if (workspaceId === undefined) throw new Error(`no workspace has ${orchestratorThreadId}`);
  await page
    .locator(
      `[data-testid="overview-workspace"][data-workspace-id="${workspaceId}"] [data-testid="overview-workspace-row"]`,
    )
    .click();
  await page.waitForURL(new RegExp(`/t/${orchestratorThreadId}$`));
}

/**
 * ⌘1 straight after a scenario seeds the first workspace: once the window knows it, as the title
 * bar's switcher naming it rather than Threads shows. Pressed sooner, it finds no workspace and
 * goes nowhere.
 */
export async function pressFirstWorkspaceKey(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-switcher-button")).not.toHaveAccessibleName(
    "Workspace: Threads",
  );
  await page.keyboard.press("ControlOrMeta+1");
}

/**
 * From a worker, up to its orchestrator by the title bar's switcher beside its crumbs, which names
 * the workspace: its current workspace's line goes to that workspace's orchestrator.
 */
export async function upToOrchestrator(page: Page, orchestratorThreadId: string): Promise<void> {
  await page.getByTestId("workspace-switcher-button").click();
  await page.getByTestId("workspace-switcher").locator('[aria-current="true"]').click();
  await page.waitForURL(new RegExp(`/t/${orchestratorThreadId}$`));
}
