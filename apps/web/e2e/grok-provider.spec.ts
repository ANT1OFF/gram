import { expect, test } from "@playwright/test";

test("Grok clearly reports the CLI routing blocker without login or purchase guidance", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.agents", "claude,codex,grok");
    sessionStorage.setItem(
      "gram.mock.settings",
      JSON.stringify({ onboarding: { welcomeSeen: true } }),
    );
  });
  await page.goto("/new");
  const form = page.getByRole("form", { name: "New thread" });
  await form.getByRole("combobox", { name: "Agent", exact: true }).click();
  await page.getByRole("option", { name: "Grok Build", exact: true }).click();
  await expect(form.getByRole("combobox", { name: "Gateway profile" })).toHaveCount(0);
  await expect(form.getByText(/^Grok Build is unavailable:/)).toBeVisible();
  await expect(
    form.getByText(/Login or a subscription purchase does not resolve this CLI limitation/),
  ).toBeVisible();
  await expect(form.getByRole("alert")).toContainText("Grok Build is unavailable in Gram");
  await expect(form.getByRole("combobox", { name: "Model", exact: true })).toHaveCount(0);
  await form.getByRole("combobox", { name: "Mode", exact: true }).click();
  await page.getByRole("option", { name: "Ask", exact: true }).click();
  await expect(form.getByRole("combobox", { name: "Mode", exact: true })).toContainText("Ask");
  await page.screenshot({ path: testInfo.outputPath("grok-provider.png"), fullPage: true });
});
