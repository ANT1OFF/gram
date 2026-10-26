import { expect, test } from "@playwright/test";

test("a model added in Settings is offered on /new, and a removed one is not", async ({ page }) => {
  await page.goto("/settings/agents");
  const section = page.getByTestId("custom-models");
  await section.getByRole("button", { name: "Add model" }).click();
  const row = section.getByRole("listitem", { name: "Custom model 1" });
  await row.getByLabel("Model id").fill("claude-preview[1m]");
  await row.getByLabel("Name").fill("Preview, 1M context");
  await section.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("custom-models").getByRole("status")).toHaveText(
    "Custom models saved.",
  );

  // A model Claude Code's own settings mention is one click to add; one the agent lists isn't offered.
  const suggestions = page.getByTestId("model-suggestions");
  await expect(suggestions.getByRole("button", { name: "Add opus", exact: true })).toHaveCount(0);
  await suggestions.getByRole("button", { name: "Add claude-preview-eap" }).click();
  await expect(
    page.getByTestId("custom-models").getByRole("listitem", { name: "Custom model 2" }),
  ).toBeVisible();
  await expect(suggestions).toHaveCount(0);

  await page.goto("/new");
  const form = page.getByRole("form", { name: "New thread" });
  await form.getByRole("combobox", { name: "Model" }).click();
  await page.getByRole("option", { name: "Preview, 1M context" }).click();
  await expect(form.getByRole("combobox", { name: "Model" })).toHaveText(/Preview, 1M context/);
  // A model added by id is assumed to take an effort, unless its row says otherwise.
  await expect(form.getByRole("combobox", { name: "Effort" })).toBeVisible();

  await page.goto("/settings/agents");
  const saved = page.getByTestId("custom-models").getByRole("listitem", { name: "Custom model 1" });
  await expect(saved).toContainText("Preview, 1M context");
  await saved.getByRole("button", { name: "Custom model 1 actions" }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await page.getByTestId("custom-models").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("custom-models").getByRole("status")).toHaveText(
    "Custom models saved.",
  );
  await page.goto("/new");
  await form.getByRole("combobox", { name: "Model" }).click();
  await expect(page.getByRole("option", { name: "Claude Opus" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Preview, 1M context" })).toHaveCount(0);
});

const ACCOUNT = [
  { id: "opus", displayName: "Claude Opus", supportsEffort: false, isDefault: true },
  { id: "sonnet", displayName: "Claude Sonnet", supportsEffort: false },
];
const MYTHOS = {
  id: "claude-mythos-5-1",
  displayName: "Mythos",
  description: "Mythos 5.1 · For your hardest problems",
  supportsEffort: false,
};

test("the model picker offers what the Claude account lists, and Mythos once it's granted", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/new");
  await page.evaluate((models) => window.gramMock?.seedClaudeAccountModels(models), ACCOUNT);
  const form = page.getByRole("form", { name: "New thread" });
  const picker = form.getByRole("combobox", { name: "Model" });
  await picker.click();
  await expect(page.getByRole("option", { name: "Claude Sonnet" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Mythos" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Granted while the app runs: the picker asks again as it opens once its list is stale.
  await page.evaluate(
    (models) => window.gramMock?.seedClaudeAccountModels(models),
    [...ACCOUNT, MYTHOS],
  );
  await page.clock.fastForward("05:01");
  await picker.click();
  await page.getByRole("option", { name: "Mythos" }).click();
  await expect(picker).toHaveText(/Mythos/);
});

test("a thread on a model its Claude account no longer lists says so", async ({ page }) => {
  await page.goto("/t/t-deps");
  await page.evaluate((models) => window.gramMock?.seedClaudeAccountModels(models), ACCOUNT);
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("/model claude-mythos-5-1");
  await composer.press("Enter");
  const picker = page.getByRole("combobox", { name: "Model" });
  await expect(picker).toHaveText(/claude-mythos-5-1/);
  await expect(picker).toHaveAttribute("data-warning", "true");
  await expect(picker).toHaveAttribute(
    "title",
    "Not offered by your Claude account; it may not work",
  );
});
