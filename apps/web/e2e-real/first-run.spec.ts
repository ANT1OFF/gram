import { expect, test } from "@playwright/test";

import { startHarness, type Harness } from "./harness";

let h: Harness;

// Each scenario starts with genuinely unseen onboarding in its own synthetic server state.
test.beforeEach(async () => {
  h = await startHarness();
});

test.afterEach(async () => {
  await h?.stop();
});

test("first run lists the supported tools and persists an explicit skip", async ({ page }) => {
  await h.open(page);
  const welcome = page.getByTestId("welcome");
  const tools = welcome.getByRole("list", { name: "Tools" }).getByRole("listitem");
  await expect(tools).toHaveText([/Claude Code/, /Codex/, /git/, /GitHub CLI/]);
  // The harness owns subscription readiness and gh; none of these probes use host accounts.
  for (const tool of ["claude", "codex", "git", "gh"]) {
    await expect(welcome.locator(`[data-tool="${tool}"]`)).toHaveAttribute("data-state", "ready");
  }
  await page.reload();
  await expect(welcome).toBeVisible();
  await welcome.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(welcome).toBeHidden();
  await page.reload();
  await expect(page.getByTestId("gateway-offer")).toHaveCount(0);
  await expect(welcome).toBeHidden();
});

test("first run selects a repository, creates the workspace on one sheet, and persists model choices", async ({
  page,
}, testInfo) => {
  await h.open(page);
  const welcome = page.getByTestId("welcome");
  await welcome.getByRole("button", { name: "Other folder", exact: true }).click();
  const addRepo = welcome.getByRole("combobox", { name: "Folder, GitHub repo or URL" });
  await addRepo.fill(`${h.root}/missing-repository`);
  await addRepo.press("Enter");
  await expect(welcome.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(`${h.origin_url()}/`);
  await addRepo.fill(h.repo);
  await addRepo.press("Enter");
  await expect(page).toHaveURL(/\/new-workspace\?repo=/);

  const sheet = page.getByRole("form", { name: "New workspace" });
  await expect(sheet.getByTestId("new-workspace-repo")).toHaveText("web");
  await expect(sheet.getByLabel("What should it work on?")).toBeFocused();
  // Merely selecting a repository doesn't complete onboarding.
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(welcome).toBeVisible();
  await page.reload();
  await expect(welcome).toBeVisible();
  await welcome
    .getByRole("list", { name: "Repositories" })
    .getByRole("button", { name: /^web/ })
    .click();
  await expect(sheet.getByTestId("new-workspace-repo")).toHaveText("web");

  // Empty selection is refused, and selecting the repo again recovers on the same sheet.
  await sheet.getByRole("button", { name: "Remove web", exact: true }).click();
  await sheet.getByRole("button", { name: /^Start/ }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Pick at least one repository.");
  await sheet.getByRole("checkbox", { name: /web/ }).check();
  await sheet.getByLabel("What should it work on?").fill("Plan the needle notes");
  await sheet.getByRole("radio", { name: "Supervised", exact: true }).click();
  await sheet.getByRole("radio", { name: "Full", exact: true }).click();
  const confirm = sheet.getByRole("alertdialog", { name: "Turn on Full autonomy?" });
  await confirm.getByRole("button", { name: "Keep Supervised", exact: true }).click();
  await expect(sheet.getByRole("radio", { name: "Supervised", exact: true })).toBeChecked();
  await sheet.getByRole("radio", { name: "Full", exact: true }).click();
  await confirm.getByRole("button", { name: "Turn on Full", exact: true }).click();
  await expect(sheet.getByRole("radio", { name: "Full", exact: true })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("workspace-sheet.png") });
  await sheet.getByRole("button", { name: /^Start/ }).click();

  await expect(page.getByTestId("pane-role")).toHaveText("Orchestrator", { timeout: 30_000 });
  await expect(page.getByTestId("pane-header").getByRole("heading")).toHaveAccessibleName(
    "Orchestrator: web",
  );
  await expect(page.getByText("echo: Plan the needle notes", { exact: true })).toBeVisible();
  await h.open(page);
  await expect(welcome).toBeHidden();
  await expect(page.getByTestId("gateway-offer")).toHaveCount(0);

  // Models now live in workspace settings, rather than creation steps.
  await h.open(page, "/settings/workspaces");
  const made = page.getByRole("listitem", { name: "Workspace web", exact: true });
  await expect(made.getByTestId("workspace-autonomy")).toHaveText("Full");
  await made.getByTestId("workspace-link").click();
  const settingsUrl = page.url();
  const settings = page.getByTestId("workspace-page");
  await expect(settings.getByTestId("worker-model")).toHaveCount(0);
  await expect(
    settings
      .getByTestId("orchestrator-model")
      .getByRole("combobox", { name: "Model", exact: true }),
  ).toContainText("Fake Opus (echo)");
  await settings.getByTestId("worker-model-add").click();
  const modelForm = settings.getByTestId("worker-model-form");
  await modelForm.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: "Fake Haiku (echo)", exact: true }).click();
  await modelForm.getByRole("textbox", { name: "What this model is for" }).fill("small reviews");
  await modelForm.getByTestId("worker-model-save").click();
  const savedWorker = settings.getByTestId("worker-model");
  await savedWorker.getByRole("combobox", { name: "Speed" }).click();
  await page.getByRole("option", { name: "Standard", exact: true }).click();
  await page.reload();
  await expect(savedWorker).toHaveCount(1);
  await expect(savedWorker).toContainText("fake-haiku");
  await expect(savedWorker.getByTestId("worker-model-note")).toHaveValue("small reviews");
  await expect(savedWorker.getByRole("combobox", { name: "Speed" })).toContainText("Standard");
  await expect(savedWorker.getByTestId("worker-model-effort")).toHaveCount(0);
  await expect(
    settings
      .getByTestId("orchestrator-model")
      .getByRole("combobox", { name: "Model", exact: true }),
  ).toContainText("Fake Opus (echo)");
  await expect(page).toHaveURL(settingsUrl);

  await h.open(page, "/settings/workspaces");
  await made.getByRole("button", { name: "Workspace web actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "New workspace like this…", exact: true }).click();
  await expect(sheet.getByTestId("new-workspace-from")).toHaveText("Setup from web");
  await expect(sheet.getByRole("radio", { name: "Full", exact: true })).toBeChecked();
  await expect(page.getByTestId("workspace-guide")).toHaveCount(0);
});
