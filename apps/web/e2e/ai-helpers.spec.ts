import { expect, test } from "@playwright/test";

test("fresh helpers prefer local Haiku with independent destination consent", async ({ page }) => {
  await page.goto("/settings/ai-helpers");
  const source = page.getByRole("combobox", { name: "Helper source", exact: true });
  await expect(source).toContainText("Automatic (local subscriptions)");
  await expect(
    page.getByRole("combobox", { name: "Claude Code / Anthropic helper model" }),
  ).toContainText("Haiku 5.5");
  await expect(
    page.getByRole("combobox", { name: "Helper context to Claude Code / Anthropic" }),
  ).toContainText("No context (off)");
  await page.getByText("Advanced · fallback and context").click();
  await expect(page.getByText(/Claude is tool-free; Codex uses guided generation/)).toBeVisible();
  await expect(page.getByText("Helpers have no tools", { exact: false })).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Helper context to Codex / OpenAI" }),
  ).toContainText("No context (off)");
  await expect(page.getByRole("switch", { name: "Thread titles", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Gateway estimate limit")).toHaveCount(0);
  await expect(
    page.getByText(/Residual native tools and CLI host instructions/).first(),
  ).toBeVisible();

  await page.getByRole("combobox", { name: "Helper context to Claude Code / Anthropic" }).click();
  await page.getByRole("option", { name: "Opening message (titles)", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Thread titles", exact: true })).toBeEnabled();
  await expect(page.getByRole("switch", { name: "Thread plans", exact: true })).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "Helper context to Codex / OpenAI" }),
  ).toContainText("No context (off)");

  await source.click();
  await page.getByRole("option", { name: "Codex (local)", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Local helper fallback" })).toContainText("None");
  await expect(page.getByRole("switch", { name: "Thread titles", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Codex / OpenAI helper model" })).toContainText(
    "GPT-6 Luna",
  );
  await expect(
    page.getByRole("combobox", { name: "Helper model for Personal Gateway" }),
  ).toHaveCount(0);
  await source.click();
  await page.getByRole("option", { name: "Gateway (optional)", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Helper context permission" })).toHaveValue(
    "off",
  );
  await expect(page.getByLabel("Gateway estimate limit")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Thread titles", exact: true })).toBeDisabled();
  await source.click();
  await page.getByRole("option", { name: "Automatic (local subscriptions)", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Helper context to Claude Code / Anthropic" }),
  ).toContainText("Opening message");
});

for (const width of [1440, 640]) {
  test(`harness, model and effort save and reload at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/settings/ai-helpers");
    const effort = page.getByRole("combobox", { name: "Claude Code / Anthropic helper effort" });
    await expect(effort).toContainText("High effort");
    await effort.click();
    await page.getByRole("option", { name: "Low effort", exact: true }).click();
    const model = page.getByRole("combobox", { name: "Claude Code / Anthropic helper model" });
    await model.click();
    await page.getByRole("option", { name: "Haiku 5.5", exact: true }).click();
    await expect(model).toContainText("Haiku 5.5");
    await expect(effort).toContainText("Low effort");
    await page.reload();
    await expect(effort).toContainText("Low effort");
    await expect(model).toContainText("Haiku 5.5");
    await expect(
      page.getByRole("combobox", { name: "Helper context to Claude Code / Anthropic" }),
    ).toContainText("No context (off)");
    const info = page.getByRole("button", { name: "Claude Code / Anthropic helper information" });
    await effort.focus();
    await page.keyboard.press("Tab");
    await expect(info).toBeFocused();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText(
      "Synthetic preview",
    );
    await expect(info).toHaveAttribute("aria-describedby", /.+/);
    await page.keyboard.press("Escape");
    await info.hover();
    await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toContainText(
      "Synthetic preview",
    );
    await page.keyboard.press("Escape");
    await page.getByRole("combobox", { name: "Helper source" }).click();
    await page.getByRole("option", { name: "Codex (local)", exact: true }).click();
    await expect(
      page.getByText(/Residual native tools and CLI host instructions/).first(),
    ).toBeVisible();
    const codexEffort = page.getByRole("combobox", { name: "Codex / OpenAI helper effort" });
    await expect(codexEffort).toContainText("High effort");
    await codexEffort.click();
    await page.getByRole("option", { name: "Low effort", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Helper source" })).toContainText("Codex");
    await expect(codexEffort).toContainText("Low effort");
    await page.getByRole("button", { name: "Refresh local helpers", exact: true }).click();
    await expect(codexEffort).toContainText("Low effort");
    await expect(
      page.getByRole("combobox", { name: "Helper context to Codex / OpenAI" }),
    ).toContainText("No context (off)");
    await page.getByText("Advanced · fallback and context").click();
    await expect(page.getByText(/Claude is tool-free; Codex uses guided generation/)).toBeVisible();
    await expect(page.getByText("Helpers have no tools", { exact: false })).toHaveCount(0);
    const bounds = await page
      .getByTestId("ai-helper-settings")
      .evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
  });
}
