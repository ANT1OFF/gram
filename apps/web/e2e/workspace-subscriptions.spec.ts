import { expect, test, type Page } from "@playwright/test";

const seed = (page: Page, settings: object = {}) =>
  page.addInitScript(
    (value) => sessionStorage.setItem("gram.mock.settings", value),
    JSON.stringify(settings),
  );

for (const action of ["Enter", "Clone"] as const) {
  test(`workspace remote input registers and selects with ${action}`, async ({ page }) => {
    await seed(page);
    await page.goto("/new-workspace");
    const sheet = page.getByRole("form", { name: "New workspace" });
    const field = sheet.getByRole("combobox", { name: "Folder, GitHub repo or URL" });
    await field.fill("EXAMPLE/workspace-fixture");
    await page.evaluate(() => window.gramMock?.holdClones());
    if (action === "Enter") await field.press("Enter");
    else await sheet.getByRole("button", { name: action, exact: true }).click();
    await expect(sheet.getByRole("status")).toContainText("Cloning EXAMPLE/workspace-fixture");
    await page.evaluate(() => window.gramMock?.release("clone"));
    await expect(sheet.getByTestId("new-workspace-repo")).toHaveText(["workspace-fixture"]);
    await expect(sheet.getByRole("checkbox", { name: /^workspace-fixture/ })).toHaveCount(0);
    await expect(field).toHaveValue("");
    await expect(sheet.getByRole("alert")).toHaveCount(0);
  });
}

test("Start adds a typed remote first, and a failed clone stays actionable", async ({ page }) => {
  await seed(page);
  await page.goto("/new-workspace");
  const sheet = page.getByRole("form", { name: "New workspace" });
  const field = sheet.getByRole("combobox", { name: "Folder, GitHub repo or URL" });
  await field.fill("EXAMPLE/missing");
  await sheet.getByTestId("new-workspace-start").click();
  await expect(sheet.getByRole("alert")).toContainText("Couldn't clone EXAMPLE/missing");
  await expect(field).toHaveValue("EXAMPLE/missing");
  await field.fill("git@example.test:team/retry-fixture.git");
  await sheet.getByTestId("new-workspace-start").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName(
    "Orchestrator: retry-fixture",
  );
});

for (const agent of ["claude", "codex"] as const) {
  test(`selected local ${agent} remains the work agent without gateway setup`, async ({ page }) => {
    await seed(page, {
      agents: {
        defaultModel: { agent, model: agent === "claude" ? "sonnet" : "gpt-5.5" },
      },
    });
    await page.goto("/new-workspace");
    const sheet = page.getByRole("form", { name: "New workspace" });
    await sheet
      .getByTestId("new-workspace-checklist")
      .getByRole("checkbox", { name: /^api/ })
      .click();
    await expect(sheet.getByRole("link", { name: /gateway key/i })).toHaveCount(0);
    await sheet.getByTestId("new-workspace-start").click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName("Orchestrator: api");
    const workModel = await page.evaluate(async () => {
      const [workspace] = await window.gramMock!.listWorkspaces();
      return workspace!.charter.orchestratorModel;
    });
    expect(workModel?.agent).toBe(agent);
    expect(workModel).not.toHaveProperty("profileId");
    // The orchestrator's composer names its agent beside the model, as its sidebar row once did.
    const picker = page
      .locator("[data-pane-root]")
      .getByTestId("composer-toolbar")
      .getByTestId("composer-choices");
    const name = agent === "claude" ? "Claude Code" : "Codex";
    await expect(picker).toHaveAttribute("aria-description", name);
    // Said the moment it is hovered, in the instant tooltip every toolbar picker has.
    await picker.hover();
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
      new RegExp(`^${name} · (Claude Sonnet|gpt-5\\.5)`),
    );
  });
}

test("the workspace starts on the model and worker roster picked before creation", async ({
  page,
}) => {
  await page.addInitScript(() => sessionStorage.setItem("gram.mock.agents", "claude,codex"));
  await seed(page, { agents: { defaultModel: { agent: "claude", model: "sonnet" } } });
  await page.goto("/new-workspace");
  const sheet = page.getByRole("form", { name: "New workspace" });
  await sheet
    .getByTestId("new-workspace-checklist")
    .getByRole("checkbox", { name: /^api/ })
    .click();
  await sheet.getByText("Models", { exact: true }).click();

  const lead = sheet.getByTestId("orchestrator-model");
  await lead.getByRole("combobox", { name: "Agent", exact: true }).click();
  await page.getByRole("option", { name: "Codex", exact: true }).click();
  await lead.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: "GPT-5.5", exact: true }).click();

  const workers = sheet.getByTestId("worker-models");
  await workers.getByTestId("worker-model-add").click();
  const workerForm = workers.getByTestId("worker-model-form");
  const workerAgent = workerForm.getByRole("combobox", { name: "Agent", exact: true });
  await workerAgent.press("ArrowDown");
  const agents = page.locator(`[id="${await workerAgent.getAttribute("aria-controls")}"]`);
  await agents.getByRole("option", { name: "Codex", exact: true }).press("Enter");
  const workerModel = workerForm.getByRole("combobox", { name: "Model", exact: true });
  await workerModel.press("ArrowDown");
  const models = page.locator(`[id="${await workerModel.getAttribute("aria-controls")}"]`);
  await models.getByRole("option", { name: "GPT-6.1-Sol", exact: true }).press("Enter");
  await workers.getByTestId("worker-model-save").click();
  const worker = workers.getByTestId("worker-model").last();
  await worker.getByRole("button", { name: /^Default worker model: Codex/ }).click();
  await sheet.getByTestId("new-workspace-start").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName("Orchestrator: api");

  const model = await page.evaluate(async () => {
    const [workspace] = await window.gramMock!.listWorkspaces();
    const { orchestratorModel, workerModels } = workspace!.charter;
    const defaultWorker = workerModels?.find((entry) => entry.default);
    return { orchestratorModel, defaultWorker };
  });
  expect(model.orchestratorModel).toMatchObject({ agent: "codex", model: "gpt-5.5" });
  expect(model.defaultWorker).toMatchObject({ agent: "codex", model: "gpt-6.1-sol" });
});
