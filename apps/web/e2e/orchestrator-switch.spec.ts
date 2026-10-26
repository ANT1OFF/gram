import { expect, test } from "@playwright/test";
import { pressFirstWorkspaceKey } from "./thread-row";

test("explicit orchestrator switch separates current and requested models, cancellation and future preference", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({ claudeSignIn: "signedIn", codexSignIn: "signedIn", ghSignedIn: false }),
    );
    sessionStorage.setItem(
      "gram.mock.settings",
      JSON.stringify({ onboarding: { welcomeSeen: true } }),
    );
    window.gramMockHoldGates = true;
  });
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
    return { state, thread };
  }, made.workspaceId);
  // The existing preference editor alone does not replace the active orchestrator.
  await page.evaluate(async (id) => {
    const api = window.gramMock!;
    const state = (await api.listWorkspaces()).find((each) => each.workspace.id === id)!;
    await api.setOrchestratorCharter(id, {
      ...state.charter,
      // This successful local-Codex scenario explicitly grants Full in invented state.
      // The service policy controls separately prove Publish/Supervised refuse that target.
      autonomy: "full",
      orchestratorModel: { agent: "codex", model: "gpt-5.5" },
    });
  }, made.workspaceId);
  await expect(workspace.getByTestId("orchestrator-current")).toContainText("Claude Code");
  await workspace.getByTestId("switch-orchestrator-open").click();
  const dialog = page.getByTestId("switch-orchestrator-dialog");
  await expect(dialog).toContainText("the full provider conversation is not transferred");
  await expect(dialog.getByRole("combobox", { name: "Gateway profile" })).toHaveCount(0);
  await dialog.getByRole("combobox", { name: "Agent", exact: true }).click();
  await page.getByRole("option", { name: "Codex", exact: true }).click();
  await expect(dialog.getByTestId("switch-model-availability")).toContainText(
    "Listed by your installed CLI",
  );
  await dialog.getByTestId("switch-orchestrator-confirm").click();
  await expect(dialog.getByTestId("orchestrator-switch-status")).toContainText(
    "Previous: Claude Code",
  );
  await expect(dialog.getByTestId("orchestrator-switch-status")).toContainText("Requested: Codex");
  await expect(workspace.getByTestId("orchestrator-current")).toContainText("Claude Code");
  await dialog.getByRole("button", { name: "Cancel switch", exact: true }).click();
  await expect(dialog.getByTestId("switch-orchestrator-confirm")).toBeVisible();
  await dialog.getByTestId("switch-orchestrator-confirm").click();
  await expect(dialog.getByTestId("orchestrator-switch-status")).toBeVisible();
  await page.evaluate(() => window.gramMock!.release("orchestrator-switch"));
  await expect(dialog.getByTestId("switch-current-model")).toContainText("Codex");
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
  expect(after.state.charter.orchestratorModel).toEqual(after.thread.model);
  expect(after.state.charter.workerModels).toEqual(before.state.charter.workerModels);
  expect(after.state.paused).toEqual(before.state.paused);
  expect(errors).toEqual([]);
});

test("the orchestrator's header has no Switch pill; its ⋯ menu opens the same switch", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  const header = page.getByTestId("pane-header");
  await expect(header).toBeVisible();
  await expect(header.getByTestId("switch-orchestrator-open")).toHaveCount(0);
  await expect(header.getByText("Switch orchestrator…")).toHaveCount(0);
  await header.getByRole("button", { name: "Thread menu" }).click();
  const item = page.getByTestId("thread-menu").getByTestId("menu-switch-orchestrator");
  await expect(item).toHaveText("Switch orchestrator…");
  await item.click();
  const dialog = page.getByTestId("switch-orchestrator-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("switch-orchestrator-confirm")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});
