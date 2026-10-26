import { expect, test } from "@playwright/test";

for (const agent of ["claude", "codex"] as const)
  test(`${agent} speed persists independently of effort and resets on an unsupported model`, async ({
    page,
  }) => {
    await page.clock.install();
    await page.addInitScript((selectedAgent) => {
      sessionStorage.setItem("gram.mock.agents", "claude,codex");
      sessionStorage.setItem(
        "gram.mock.settings",
        JSON.stringify({
          onboarding: { welcomeSeen: true },
          agents: {
            defaultModel: {
              agent: selectedAgent,
              model: "fixture-fast",
              variant: "high",
              speed: "standard",
            },
          },
        }),
      );
    }, agent);
    await page.goto("/new");
    const form = page.getByRole("form", { name: "New thread" });
    await expect(form).toBeVisible();
    await page.evaluate(() => {
      const api = window.gramMock!;
      api.listModels = async () => ({
        models: [
          {
            id: "fixture-fast",
            displayName: "Synthetic Fast model",
            supportsEffort: true,
            efforts: ["low", "high"],
            speeds: ["standard", "fast"],
            isDefault: true,
          },
          {
            id: "fixture-standard",
            displayName: "Synthetic Standard model",
            supportsEffort: true,
            efforts: ["high"],
            speeds: ["standard"],
          },
        ],
      });
      const create = api.createThread;
      api.createThread = async (input) => {
        sessionStorage.setItem("gram.speed-created", JSON.stringify(input.model));
        return create.call(api, input);
      };
    });
    await page.clock.fastForward("05:01");
    await form.getByRole("combobox", { name: "Model", exact: true }).click();
    await page.getByRole("option", { name: "Synthetic Fast model", exact: true }).click();
    const speed = form.getByRole("combobox", { name: "Speed", exact: true });
    await expect(speed).toContainText("Standard");
    await speed.click();
    await expect(
      page
        .getByText(
          agent === "claude" ? /separately billed usage credits/ : /more subscription allowance/,
        )
        .last(),
    ).toBeVisible();
    await page.getByRole("option", { name: "Fast", exact: true }).click();
    await expect(form.getByRole("combobox", { name: "Effort", exact: true })).toContainText("High");
    await page.getByRole("combobox", { name: "Project path" }).fill("~/Documents/code/sandbox");
    await form.getByLabel("First prompt").fill("Synthetic speed preference test.");
    await form.getByRole("button", { name: /Create thread/ }).click();
    await expect(page).toHaveURL(/\/t\/t-/);
    expect(
      await page.evaluate(() => JSON.parse(sessionStorage.getItem("gram.speed-created")!)),
    ).toEqual({ agent, model: "fixture-fast", variant: "high", speed: "fast" });
    const currentSpeed = page.getByRole("combobox", { name: "Speed", exact: true });
    await expect(currentSpeed).toContainText("Fast");
    await page.getByRole("combobox", { name: "Model", exact: true }).click();
    await page.getByRole("option", { name: "Synthetic Standard model", exact: true }).click();
    await expect(currentSpeed).toContainText("Standard");
    await expect(page.getByRole("combobox", { name: "Effort", exact: true })).toContainText("High");
    await currentSpeed.click();
    await expect(page.getByRole("option", { name: "Fast", exact: true })).toHaveCount(0);
  });
