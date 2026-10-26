import { expect, test } from "@playwright/test";

const launchChecks = {
  tools: [
    { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.296" },
    { tool: "codex", found: true, path: "/mock/bin/codex", version: "0.162.1" },
    { tool: "git", found: true, path: "/mock/bin/git", version: "2.47.1" },
    { tool: "gh", found: false },
  ],
  claudeSignIn: "notSignedIn",
  codexSignIn: "notSignedIn",
  ghSignedIn: false,
};

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript((checks) => {
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem("gram.mock.agentRuntimes", JSON.stringify({ agents: [] }));
    sessionStorage.setItem("gram.mock.launchChecks", JSON.stringify(checks));
  }, launchChecks);
});

for (const state of [undefined, {}, { motion: "off" }]) {
  test(`fresh default before hydration, after settings load and reload (${JSON.stringify(state)})`, async ({
    page,
  }) => {
    await page.addInitScript((saved) => {
      if (sessionStorage.getItem("fixture.seeded")) return;
      if (saved) localStorage.setItem("gram.theme", JSON.stringify({ state: saved, version: 1 }));
      sessionStorage.setItem(
        "gram.mock.settings",
        JSON.stringify({ appearance: saved, onboarding: { welcomeSeen: true } }),
      );
      sessionStorage.setItem("fixture.seeded", "1");
    }, state);
    // Leave the actual inline bootstrap running, with application hydration held back.
    const modules = /\/(?:src\/main\.tsx|assets\/[^/]+\.js)(?:\?.*)?$/;
    await page.route(modules, (route) =>
      route.fulfill({ contentType: "application/javascript", body: "export {}" }),
    );
    await page.goto("/settings/appearance", { waitUntil: "domcontentloaded" });
    const root = page.locator("html");
    await expect(root).toHaveAttribute("data-look", "glass");
    await expect(root).toHaveAttribute("data-palette", "neutral-dark");
    await expect(root).toHaveAttribute("data-mode", "dark");
    await page.unroute(modules);
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: /^Appearance/ })).toBeVisible();
    await expect(root).toHaveAttribute("data-look", "glass");
    await expect(root).toHaveAttribute("data-palette", "neutral-dark");
    await expect(root).toHaveAttribute("data-mode", "dark");
    await expect(
      page
        .getByRole("group", { name: "Mode", exact: true })
        .getByRole("button", { name: "dark", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      await root.evaluate((el) => getComputedStyle(el).getPropertyValue("--p-bg").trim()),
    ).toBe("#0a0a0a");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: /^Appearance/ })).toBeVisible();
    await expect(root).toHaveAttribute("data-palette", "neutral-dark");
    await expect(root).toHaveAttribute("data-mode", "dark");
  });
}

for (const mode of ["system", "light", "dark"] as const) {
  test(`saved Tokyo Night ${mode} retains its settings and actual CSS tokens`, async ({ page }) => {
    const appearance = {
      look: "glass",
      paletteId: "tokyo-night",
      mode,
      density: "comfortable",
      contrast: "standard",
      motion: "off",
    };
    await page.addInitScript((saved) => {
      if (sessionStorage.getItem("fixture.seeded")) return;
      localStorage.setItem(
        "gram.theme",
        JSON.stringify({
          version: 1,
          state: { ...saved, palette: saved.paletteId, customPalettes: [] },
        }),
      );
      sessionStorage.setItem(
        "gram.mock.settings",
        JSON.stringify({ appearance: saved, onboarding: { welcomeSeen: true } }),
      );
      sessionStorage.setItem("fixture.seeded", "1");
    }, appearance);
    await page.goto("/settings/appearance");
    const root = page.locator("html");
    await expect(page.getByRole("heading", { level: 2, name: /^Appearance/ })).toBeVisible();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const dark = mode === "dark" || (mode === "system" && colorScheme === "dark");
      await expect(root).toHaveAttribute("data-palette", dark ? "tokyo-night" : "tokyo-light");
      await expect(root).toHaveAttribute("data-mode", dark ? "dark" : "light");
      expect(
        await root.evaluate((el) => getComputedStyle(el).getPropertyValue("--p-bg").trim()),
      ).toBe(dark ? "#1a1b26" : "#d5d6db");
    }
    await page.reload();
    await expect(root).toHaveAttribute("data-look", "glass");
    await expect(root).toHaveAttribute("data-density", "comfortable");
    await expect(root).toHaveAttribute("data-contrast", "standard");
    await expect(root).toHaveAttribute("data-motion", "off");
    expect(
      await page.evaluate(
        () => JSON.parse(sessionStorage.getItem("gram.mock.settings")!).appearance,
      ),
    ).toEqual(appearance);
  });
}
