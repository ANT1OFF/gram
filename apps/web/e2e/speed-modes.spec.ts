import { expect, test } from "@playwright/test";

import { chipFace, choicesChip, choicesPopup, openChoices } from "./composer-choices";
import { openMoreOptions } from "./new-thread-options";

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
    const chip = choicesChip(form);
    await openChoices(page, form, "model");
    // The list holds every agent's models, each under its agent's name; this agent's is the one.
    await page
      .getByTestId("model-picker")
      .getByRole("group", { name: agent === "claude" ? "Claude Code" : "Codex" })
      .getByRole("option", { name: "Synthetic Fast model", exact: true })
      .click();
    // In the new-thread form, as in a thread's composer, speed is a section of the choices, and
    // the chip draws its bolt only once it is Fast.
    await expect(chip).toHaveAccessibleName(/ · Speed: Standard$/);
    await openChoices(page, form, "speed");
    await expect(
      choicesPopup(page).getByText(
        agent === "claude" ? /separately billed usage credits/ : /more subscription allowance/,
      ),
    ).toBeVisible();
    await page.getByRole("option", { name: "Fast", exact: true }).click();
    await expect(chip).toHaveAccessibleName(/ · Speed: Fast$/);
    await expect(chip).toHaveAccessibleName(/ · Effort: High · /);
    await expect
      .poll(() => chipFace(chip))
      .toEqual({
        words: "Synthetic Fast model",
        glyphs: [expect.stringMatching(/^mode:/), "speed:fast"],
      });
    await openMoreOptions(page);
    await page.getByRole("combobox", { name: "Project path" }).fill("~/Documents/code/sandbox");
    await form.getByLabel("First prompt").fill("Synthetic speed preference test.");
    await form.getByRole("button", { name: /Start chat/ }).click();
    await expect(page).toHaveURL(/\/t\/t-/);
    expect(
      await page.evaluate(() => JSON.parse(sessionStorage.getItem("gram.speed-created")!)),
    ).toEqual({ agent, model: "fixture-fast", variant: "high", speed: "fast" });
    // The thread's composer says the same on its one chip.
    const toolbar = page.getByTestId("composer-toolbar");
    const current = choicesChip(toolbar);
    await expect(current).toHaveAccessibleName(/ · Speed: Fast/);
    await openChoices(page, toolbar, "model");
    await page.getByRole("option", { name: "Synthetic Standard model", exact: true }).click();
    await expect(current).toHaveAccessibleName(/ · Speed: Standard$/);
    await expect(current).toHaveAccessibleName(/ · Effort: High \(.+\) · /);
    await openChoices(page, toolbar, "speed");
    await expect(page.getByRole("option", { name: "Fast", exact: true })).toHaveCount(0);
  });
