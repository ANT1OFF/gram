import { expect, test, type Page } from "@playwright/test";
import { pressFirstWorkspaceKey } from "./thread-row";
import { openThreadMenu } from "./more-menu";

// The orchestrator continues in the other agent through the same "Continue in…" sheet as any
// thread, from its "…" menu and from Settings → Workspaces. Synthetic mock state only: both CLIs
// found and signed in, explicitly.

const bothAgents = (page: Page, holdGates = false) =>
  page.addInitScript((hold) => {
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({ claudeSignIn: "signedIn", codexSignIn: "signedIn", ghSignedIn: false }),
    );
    sessionStorage.setItem(
      "gram.mock.settings",
      JSON.stringify({ onboarding: { welcomeSeen: true } }),
    );
    if (hold) window.gramMockHoldGates = true;
  }, holdGates);

test("Settings → Workspaces opens Continue in Codex for the orchestrator: cancel, continue, land", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await bothAgents(page, true);
  await page.goto("/settings/workspaces");
  await expect(page.getByTestId("workspace-settings")).toBeVisible();
  const made = await page.evaluate(async () => window.gramMock!.simulateOrchestration("board"));
  await page
    .getByRole("listitem", { name: "Workspace agent-platform" })
    .getByTestId("workspace-link")
    .click();
  const workspace = page.getByTestId("workspace-page");
  await expect(workspace).toBeVisible();
  const before = await page.evaluate(async (id) => {
    const api = window.gramMock!;
    const state = (await api.listWorkspaces()).find((each) => each.workspace.id === id)!;
    const thread = await api.openOrchestrator({ workspaceId: id });
    // This successful local-Codex scenario explicitly grants Full in invented state.
    await api.setOrchestratorCharter(id, { ...state.charter, autonomy: "full" });
    return { state, thread };
  }, made.workspaceId);
  await expect(workspace.getByTestId("orchestrator-current")).toContainText("Claude Code");
  const open = workspace.getByTestId("switch-orchestrator-open");
  await expect(open).toHaveText("Continue in Codex…");
  await open.click();

  const sheet = page.getByTestId("continue-in-dialog");
  await expect(sheet.getByRole("heading", { name: "Continue in Codex" })).toBeVisible();
  await expect(sheet.getByTestId("continue-in-model")).toContainText("GPT");
  await expect(sheet.getByTestId("continue-in-carries")).toHaveText(
    "A note from Claude, your last exchanges, memory, the charter and the ledger.",
  );
  await expect(sheet.getByTestId("continue-in-orchestrator")).toHaveText(
    "Workers keep their own agents, and this pick becomes the workspace's orchestrator model.",
  );
  await expect(sheet.getByTestId("continue-in-note")).toBeChecked();
  await expect(sheet.getByRole("combobox", { name: "Gateway profile" })).toHaveCount(0);
  // Unticked, the note leaves the line.
  await sheet.getByTestId("continue-in-note").uncheck();
  await expect(sheet.getByTestId("continue-in-carries")).toHaveText(
    "Your last exchanges, memory, the charter and the ledger.",
  );
  await sheet.getByTestId("continue-in-note").check();

  // Under way, the sheet says where it stands and can call it off before the old session stops.
  await sheet.getByTestId("continue-in-confirm").click();
  await expect(sheet.getByTestId("continue-in-status")).toContainText("Waiting for current work");
  await expect(workspace.getByTestId("orchestrator-current")).toContainText("Claude Code");
  await sheet.getByTestId("continue-in-cancel-switch").click();
  await expect(sheet.getByTestId("continue-in-confirm")).toBeVisible();

  await sheet.getByTestId("continue-in-confirm").click();
  await expect(sheet.getByTestId("continue-in-status")).toBeVisible();
  await page.evaluate(() => window.gramMock!.release("orchestrator-switch"));
  // Landed: the sheet closes, and the row names the new agent.
  await expect(sheet).toBeHidden();
  await expect(workspace.getByTestId("orchestrator-current")).toContainText("Codex");
  const after = await page.evaluate(async (id) => {
    const api = window.gramMock!;
    return {
      state: (await api.listWorkspaces()).find((each) => each.workspace.id === id)!,
      thread: await api.openOrchestrator({ workspaceId: id }),
    };
  }, made.workspaceId);
  expect(after.thread.id).toBe(before.thread.id);
  expect(after.thread.agentSessionId).not.toBe(before.thread.agentSessionId);
  expect(after.thread.model.agent).toBe("codex");
  // §3.5: the pick is the charter's orchestrator model now, the user's own.
  expect(after.state.charter.orchestratorModel).toEqual(after.thread.model);
  expect(after.state.charter.workerModels).toEqual(before.state.charter.workerModels);
  expect(after.state.paused).toEqual(before.state.paused);
  expect(errors).toEqual([]);
});

test("the orchestrator's ⋯ menu has Continue in Codex…, which opens the same sheet", async ({
  page,
}) => {
  await bothAgents(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  const header = page.getByTestId("pane-header");
  await expect(header).toBeVisible();
  await expect(header.getByText("Switch orchestrator…")).toHaveCount(0);
  const menu = await openThreadMenu(page);
  await expect(menu.getByTestId("menu-switch-orchestrator")).toHaveCount(0);
  const item = menu.getByTestId("menu-continue-in");
  await expect(item).toHaveText("Continue in Codex…");
  await item.click();
  const sheet = page.getByTestId("continue-in-dialog");
  await expect(sheet.getByRole("heading", { name: "Continue in Codex" })).toBeVisible();
  await expect(sheet.getByTestId("continue-in-orchestrator")).toBeVisible();
  await expect(sheet.getByTestId("continue-in-confirm")).toBeEnabled();
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toBeHidden();
});

test("with only Claude installed, the orchestrator shows nothing new", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        tools: [{ tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.273" }],
        claudeSignIn: "signedIn",
        codexSignIn: "notSignedIn",
        ghSignedIn: false,
      }),
    );
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  const menu = await openThreadMenu(page);
  await expect(menu.getByRole("menuitem", { name: "Fork thread" })).toBeVisible();
  await expect(menu.getByTestId("menu-continue-in")).toHaveCount(0);
  await expect(menu.getByTestId("menu-switch-orchestrator")).toHaveCount(0);
});
