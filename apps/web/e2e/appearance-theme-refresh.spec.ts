import { expect, test } from "@playwright/test";

import { seedTheme } from "./seed-theme";

const families = ["Neutral", "Rose", "Forest", "Ocean", "Ember", "Violet"];
const launchChecks = {
  tools: [
    { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.273" },
    { tool: "codex", found: true, path: "/mock/bin/codex", version: "0.159.2" },
    { tool: "git", found: true, path: "/mock/bin/git", version: "2.47.1" },
    { tool: "gh", found: false },
  ],
  claudeSignIn: "notSignedIn",
  ghSignedIn: false,
};

for (const name of families) {
  test(`${name} pair follows keyboard choice, mode, system and reload`, async ({
    page,
  }, testInfo) => {
    await seedTheme(page, { palette: "tokyo-night", mode: "dark", motion: "off" });
    await page.addInitScript((checks) => {
      sessionStorage.setItem("gram.mock.launchChecks", JSON.stringify(checks));
      sessionStorage.setItem("gram.mock.agents", "claude,codex");
    }, launchChecks);
    await page.clock.setFixedTime(new Date("2026-06-15T10:00:00Z"));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/settings/appearance");
    const root = page.locator("html");
    // Glass is the only look, so there is no Look control.
    await expect(page.getByRole("heading", { name: "Look", exact: true })).toHaveCount(0);
    const palettes = page.getByRole("heading", { name: "Palette", exact: true }).locator("..");
    const id = name.toLowerCase();
    const choice = palettes.getByRole("button", { name, exact: true });
    await choice.focus();
    await page.keyboard.press("Space");
    await expect(choice).toHaveAttribute("aria-pressed", "true");
    for (const mode of ["light", "dark"] as const) {
      await page
        .getByRole("group", { name: "Mode", exact: true })
        .getByRole("button", { name: mode, exact: true })
        .click();
      const resolved = `${id}${mode === "dark" ? "-dark" : ""}`;
      await expect(root).toHaveAttribute("data-palette", resolved);
      await expect
        .poll(() =>
          page.evaluate(() => JSON.parse(sessionStorage.getItem("gram.mock.settings")!).appearance),
        )
        // The card was chosen in dark mode, so the dark half is stored; pairing shows the other.
        .toMatchObject({ paletteId: `${id}-dark`, mode });
      await page.reload();
      await expect(root).toHaveAttribute("data-palette", resolved);
      await expect(choice).toHaveAttribute("aria-pressed", "true");
      await page.goto("/t/t-flaky");
      await expect(page.getByTestId("approval-card")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: testInfo.outputPath(`${id}-${mode}-thread.png`),
        animations: "disabled",
      });
      const tokens = await root.evaluate((el) => {
        const css = getComputedStyle(el);
        return [
          "surface-1",
          "surface-2",
          "fg",
          "focus-ring",
          "status-needs",
          "status-working",
          "danger-text",
          "selection",
          "diff-add-bg",
          "diff-del-bg",
          "ansi-red",
          "ansi-background",
        ].map((key) => css.getPropertyValue(`--${key}`).trim());
      });
      expect(tokens.every((value) => /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(value))).toBe(true);
      await page.goto("/settings/appearance");
    }
    await page
      .getByRole("group", { name: "Mode", exact: true })
      .getByRole("button", { name: "system", exact: true })
      .click();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(root).toHaveAttribute(
        "data-palette",
        `${id}${colorScheme === "dark" ? "-dark" : ""}`,
      );
    }
    await expect
      .poll(() =>
        page.evaluate(
          () => JSON.parse(sessionStorage.getItem("gram.mock.settings")!).appearance.mode,
        ),
      )
      .toBe("system");
    await page.reload();
    await expect(root).toHaveAttribute("data-palette", `${id}-dark`);
    await page.setViewportSize({ width: 780, height: 900 });
    await choice.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: testInfo.outputPath(`${id}-narrow-settings.png`),
      animations: "disabled",
    });
  });
}

for (const name of families) {
  for (const mode of ["light", "dark"] as const) {
    test(`${name} ${mode} terminal retains input and distinct search highlights`, async ({
      page,
    }, testInfo) => {
      const id = name.toLowerCase();
      await seedTheme(page, { palette: id, mode, motion: "off" });
      await page.addInitScript((checks) => {
        sessionStorage.setItem("gram.mock.launchChecks", JSON.stringify(checks));
        sessionStorage.setItem("gram.mock.agents", "claude,codex");
      }, launchChecks);
      await page.clock.setFixedTime(new Date("2026-06-15T10:00:00Z"));
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto("/t/t-flaky");
      const panel = page.getByTestId("right-panel");
      await panel.getByRole("tab", { name: "Terminal", exact: true }).click();
      const terminal = panel.getByTestId("terminal").first();
      await expect(terminal.locator("[data-terminal-text]")).toContainText("$", {
        timeout: 15_000,
      });
      await expect(page.locator("html")).toHaveAttribute(
        "data-palette",
        `${id}${mode === "dark" ? "-dark" : ""}`,
      );
      await terminal.getByTestId("terminal-surface").click();
      for (const line of ["theme needle one", "theme needle two"]) {
        await page.keyboard.type(line);
        await page.keyboard.press("Enter");
      }
      await expect(terminal.locator("[data-terminal-text]")).toContainText(
        "echo: theme needle two",
      );
      await page.keyboard.press("ControlOrMeta+KeyF");
      const field = terminal.getByRole("textbox", { name: "Find in terminal" });
      await field.fill("echo: theme needle");
      await expect(terminal.getByTestId("terminal-find-status")).toHaveText(/^[12] of 2$/);
      const matches = terminal.locator("[data-terminal-find-match]");
      await expect(matches).toHaveCount(2);
      await expect
        .poll(() =>
          matches.evaluateAll(
            (boxes) => new Set(boxes.map((box) => getComputedStyle(box).backgroundColor)).size,
          ),
        )
        .toBe(2);
      await expect(terminal.locator("[data-terminal-find-match='active']")).toHaveCSS(
        "outline-style",
        "solid",
      );
      await page.screenshot({
        path: testInfo.outputPath(`${id}-${mode}-terminal.png`),
        animations: "disabled",
      });
      await field.press("Escape");
      await expect(field).toBeHidden();
      await expect(terminal.getByRole("alert")).toHaveCount(0);
    });
  }
}
