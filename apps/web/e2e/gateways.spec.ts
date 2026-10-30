import { expect, test, type Page } from "@playwright/test";

import { openAdvancedPage } from "./settings-nav";

const MOCK_AGENTS_KEY = "gram.mock.agents";

/** Client-side, so the mock keeps its gateways; a reload would reset them. */
const openNewThread = async (page: Page) => {
  await page.keyboard.press("ControlOrMeta+KeyT");
  await expect(page).toHaveURL(/\/new$/);
};

const pickAgent = async (page: Page, agent: string) => {
  await page.getByRole("form", { name: "New thread" }).getByLabel("Agent").click();
  await page.getByRole("option", { name: agent, exact: true }).click();
};

// Two tests rather than one long flow: the whole flow outran the test timeout on the Windows runner.
test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => sessionStorage.setItem(key, "claude,codex"), MOCK_AGENTS_KEY);
  await page.goto("/settings/gateways");
  await expect(page.getByRole("button", { name: "Add gateway" })).toBeVisible();
});

test("a gateway profile is created, keyed, discovers models and is made default", async ({
  page,
}) => {
  // 1. Create a profile.
  await page.getByRole("button", { name: "Add gateway" }).click();
  const addForm = page.getByRole("form", { name: "Add gateway" });
  await addForm.getByLabel("Name", { exact: true }).fill("Team Gateway");
  await addForm.getByLabel("Base URL").fill("https://gw.example.test/v1");
  await addForm.getByRole("button", { name: "Save gateway" }).click();
  const team = page.getByRole("article", { name: "Team Gateway" });
  await expect(team).toBeVisible();
  await expect(team).toContainText("No API key yet");

  // 2. Set a key, then replace it.
  const keyField = team.getByLabel("API key", { exact: true });
  await keyField.fill("sk-e2e-first");
  await team.getByRole("button", { name: "Save key" }).click();
  await expect(team).toContainText("Saved securely in the macOS Keychain");
  await expect(team.getByRole("status")).toContainText(/Found \d+ models/);
  await expect(keyField).toHaveValue("");

  const replace = team.getByRole("button", { name: "Replace key" });
  await expect(replace).toBeDisabled();
  await keyField.fill("sk-e2e-second");
  await replace.click();
  await expect(keyField).toHaveValue("");
  await expect(team).toContainText("Saved securely in the macOS Keychain");
  await expect(page.getByText(/sk-e2e-/)).toHaveCount(0);

  // 3. Discover models.
  await team.getByRole("button", { name: "Discover models" }).click();
  const models = team.getByRole("list", { name: "Models for Team Gateway" });
  await expect(models.getByRole("listitem")).toHaveCount(3);
  await expect(models).toContainText("gpt-5.6-sol");

  // 4. Make it the default.
  await team.getByRole("button", { name: "Gateway Team Gateway actions" }).click();
  await page.getByRole("menuitem", { name: "Set as default" }).click();
  await expect(team.getByText("Default", { exact: true })).toBeVisible();
  // The same actions are on the row's right-click, and the default can't be made default again.
  await team.getByRole("heading", { name: "Team Gateway" }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Remove…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Set as default" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("Claude Code and Codex use a gateway only after explicit selection, offered once it has a key", async ({
  page,
}) => {
  // The keyed default profile the first test builds through the UI.
  await page.evaluate(async () => {
    const mock = window.gramMock!;
    await mock.upsertProfile({
      id: "team-gateway" as never,
      name: "Team Gateway",
      baseURL: "https://gw.example.test/v1",
      keyRef: "",
      models: [],
      default: true,
    });
    await mock.setProfileKey("team-gateway" as never, "sk-e2e-seeded");
  });
  const team = page.getByRole("article", { name: "Team Gateway" });
  await expect(team.getByText("Default", { exact: true })).toBeVisible();
  await expect(team).toContainText("Saved securely in the macOS Keychain");

  // 5. A saved default never overrides the local subscription/provider choice.
  await openNewThread(page);
  const form = page.getByRole("form", { name: "New thread" });
  for (const agent of ["Claude Code", "Codex"]) {
    await pickAgent(page, agent);
    await expect(form.getByLabel("Gateway profile")).toContainText("Subscription");
    await form.getByLabel("Gateway profile").click();
    await page.getByRole("option", { name: "Team Gateway", exact: true }).click();
    await expect(form.getByLabel("Gateway profile")).toContainText("Team Gateway");
    await expect(form.getByLabel("Model")).toContainText("GPT-5.5");
    await expect(form.getByRole("link", { name: "Add your gateway key" })).toHaveCount(0);
  }

  // 6. Removing the key leaves the subscription the only way in, so the picker goes; then remove
  // the profile.
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/gateways$/);
  await team.getByRole("button", { name: "Remove key" }).click();
  await expect(team).toContainText("No API key yet");

  await openNewThread(page);
  await pickAgent(page, "Claude Code");
  await expect(form.getByLabel("Model")).toBeVisible();
  await expect(form.getByLabel("Gateway profile")).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/gateways$/);
  await team.getByRole("button", { name: "Gateway Team Gateway actions" }).click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  await team.getByRole("button", { name: "Remove gateway" }).click();
  await expect(team).toHaveCount(0);
});

test("the default gateway's helper model is picked in AI helpers and sticks", async ({ page }) => {
  await openAdvancedPage(page, "AI helpers");
  await page.getByRole("combobox", { name: "Helper source", exact: true }).click();
  await page.getByRole("option", { name: "Gateway (optional)", exact: true }).click();
  const picker = page.getByRole("combobox", { name: "Helper model for Personal Gateway" });
  await expect(picker).toContainText("Automatic — currently");
  await picker.click();
  await page
    .getByRole("listbox")
    .getByRole("option", { name: "Claude Sonnet (gateway)", exact: true })
    .click();
  await expect(picker).toContainText("Claude Sonnet (gateway)");
  const chosen = (await picker.textContent()) ?? "";

  // Client-side, so the mock keeps the profile; a reload would reset it.
  await openAdvancedPage(page, "Gateways");
  const litellm = page.getByRole("article", { name: "Personal Gateway" });
  await expect(litellm).toContainText("Gateway helper model when selected: claude-sonnet.");
  await openAdvancedPage(page, "AI helpers");
  await expect(picker).toHaveText(chosen);
});

test("a long gateway list is searched in the draft's model picker", async ({ page }) => {
  await page.evaluate(async () => {
    const mock = window.gramMock!;
    const [profile] = await mock.listProfiles();
    await mock.setProfileKey(profile!.id, "sk-test");
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `team-${i}`,
      name: `Team model ${i}`,
    }));
    await mock.upsertProfile({ ...profile!, models: [...profile!.models, ...many] });
  });
  await openNewThread(page);
  await pickAgent(page, "Claude Code");
  const form = page.getByRole("form", { name: "New thread" });
  await form.getByLabel("Gateway profile").click();
  await page.getByRole("option", { name: "Personal Gateway", exact: true }).click();
  await form.getByRole("combobox", { name: "Model", exact: true }).click();
  const search = page.getByRole("combobox", { name: "Search models" });
  await search.fill("model 27");
  const picker = page
    .getByRole("listbox")
    .and(page.locator(`[id="${await search.getAttribute("aria-controls")}"]`));
  await expect(picker.getByRole("option")).toHaveCount(1);
  await picker.getByRole("option", { name: /Team model 27/ }).click();
  await expect(form.getByRole("combobox", { name: "Model", exact: true })).toContainText(
    "Team model 27",
  );
});
