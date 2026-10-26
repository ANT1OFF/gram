import { expect, type Page } from "@playwright/test";

/**
 * Opens a workspace's orchestrator from its tile on the overview's compact rail, which is what a
 * window under 1280 px wide shows in place of the open overview. Nothing reloads, so a scenario
 * seeded in memory stays.
 */
export async function openOrchestratorTile(
  page: Page,
  orchestratorThreadId: string,
): Promise<void> {
  const workspaceId = await page.evaluate(
    async (id) =>
      (await window.gramMock!.listWorkspaces()).find(
        (state) => state.workspace.orchestratorThreadId === id,
      )?.workspace.id,
    orchestratorThreadId,
  );
  if (workspaceId === undefined) throw new Error(`no workspace has ${orchestratorThreadId}`);
  const rail = page.getByTestId("overview-rail");
  await rail.locator(`[data-testid="overview-tile"][data-workspace-id="${workspaceId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/t/${orchestratorThreadId}$`));
  // Off the rail, as a user's pointer moves on, so no tile's hover flyout stays over the page.
  const box = (await rail.boundingBox())!;
  await page.mouse.move(box.x + box.width + 300, box.y + box.height / 2);
  await expect(page.getByTestId("overview-flyout")).toHaveCount(0);
}
