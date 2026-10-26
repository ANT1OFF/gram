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
    await expect(sheet.getByRole("checkbox", { name: /^workspace-fixture/ })).toBeChecked();
    await expect(sheet.getByTestId("new-workspace-repo")).toHaveText(["workspace-fixture"]);
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
      .check();
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
      .getByRole("combobox", { name: "Model" });
    await expect(picker).toHaveAttribute(
      "title",
      new RegExp(`^${agent === "claude" ? "Claude Code" : "Codex"} · `),
    );
  });
}
