import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem(
      "gram.mock.settings",
      JSON.stringify({ onboarding: { welcomeSeen: true } }),
    );
  });
});

test("Codex starts a thread with its own model and credentials without configuring a gateway", async ({
  page,
}) => {
  await page.goto("/new");
  const form = page.getByRole("form", { name: "New thread" });
  await form.getByRole("combobox", { name: "Agent" }).click();
  await page.getByRole("option", { name: "Codex", exact: true }).click();
  await expect(form.getByRole("combobox", { name: "Gateway profile" })).toHaveText(
    /^Subscription(?:▼)?$/,
  );
  await expect(form.getByRole("combobox", { name: "Model", exact: true })).toContainText("GPT-5.5");
  await expect(form.getByRole("link", { name: "Add your gateway key" })).toHaveCount(0);

  await page.evaluate(() => {
    const api = window.gramMock!;
    const create = api.createThread;
    api.createThread = async (input) => {
      sessionStorage.setItem("gram.e2e.createdModel", JSON.stringify(input.model));
      return create.call(api, input);
    };
  });
  await page.getByRole("combobox", { name: "Project path" }).fill("~/Documents/code/sandbox");
  await form.getByLabel("First prompt").fill("Explain this project.");
  await form.getByRole("button", { name: /Create thread/ }).click();
  await expect(page).toHaveURL(/\/t\/t-/);
  expect(
    await page.evaluate(() => JSON.parse(sessionStorage.getItem("gram.e2e.createdModel")!)),
  ).toEqual({ agent: "codex", model: "gpt-5.5", speed: "standard" });
});

test("signed-out Codex remains selectable and retrying after login discovers its account models", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({ codexSignIn: "notSignedIn" }),
    );
  });
  await page.goto("/new");
  const form = page.getByRole("form", { name: "New thread" });
  await form.getByRole("combobox", { name: "Agent" }).click();
  await page.getByRole("option", { name: "Codex", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("codex login");
  await expect(form.getByRole("combobox", { name: "Model", exact: true })).toHaveCount(0);
  await expect(form.getByRole("button", { name: /Create thread/ })).toBeDisabled();
  await page.evaluate(() => {
    sessionStorage.setItem("gram.mock.launchChecks", JSON.stringify({ codexSignIn: "signedIn" }));
  });
  await form.getByRole("button", { name: "Retry models" }).click();
  await expect(form.getByRole("combobox", { name: "Model", exact: true })).toContainText("GPT-5.5");
  await expect(form.getByRole("alert")).toHaveCount(0);
  await expect(form.getByRole("combobox", { name: "Gateway profile" })).toHaveText(
    /^Subscription(?:▼)?$/,
  );
});

test("Codex-only diagnostics show ChatGPT login and recover on re-check without requiring Claude", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "gram.mock.settings",
      JSON.stringify({
        onboarding: { welcomeSeen: true },
        agents: { defaultModel: { agent: "codex", model: "gpt-5.5" } },
      }),
    );
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        codexSignIn: "notSignedIn",
        claudeSignIn: "notSignedIn",
        localAgentsInUse: ["codex"],
        agentsInUse: ["codex"],
      }),
    );
  });
  await page.goto("/settings/diagnostics");
  const tools = page.getByTestId("tool-checks");
  await expect(tools).toContainText("not signed in");
  const banner = page.getByTestId("launch-checks-banner");
  await expect(banner).toContainText("Codex isn't signed in");
  await expect(banner).not.toContainText("Claude Code isn't signed in");
  await page.evaluate(() => {
    const key = "gram.mock.launchChecks";
    const checks = JSON.parse(sessionStorage.getItem(key)!);
    sessionStorage.setItem(key, JSON.stringify({ ...checks, codexSignIn: "signedIn" }));
  });
  await page
    .getByRole("region", { name: "Tools", exact: true })
    .getByRole("button", { name: "Re-check" })
    .click();
  await expect(tools).toContainText("ChatGPT login");
  await expect(banner).toBeHidden();
});
