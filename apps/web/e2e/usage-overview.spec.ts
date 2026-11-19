import { expect, test, type Page } from "@playwright/test";

const seed = (page: Page, state = "sample") =>
  page.addInitScript((value) => {
    sessionStorage.setItem("gram.mock.usage", value);
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        tools: [
          { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.296" },
          { tool: "codex", found: true, path: "/mock/bin/codex", version: "0.170.0" },
          { tool: "git", found: true, path: "/mock/bin/git" },
          { tool: "gh", found: true, path: "/mock/bin/gh" },
        ],
        claudeSignIn: "notSignedIn",
        codexSignIn: "notSignedIn",
        ghSignedIn: false,
      }),
    );
    sessionStorage.setItem(
      "gram.mock.settings",
      JSON.stringify({
        appearance: { mode: "dark", paletteId: "catppuccin-mocha", motion: "off" },
        helpers: { source: "local" },
      }),
    );
    sessionStorage.setItem("gram.mock.agentRuntimes", JSON.stringify({ agents: [] }));
  }, state);

const tokens = (page: Page) => page.getByTestId("usage-tokens");
/** The page's own total, exact, whatever the compact text reads. */
const expectTokens = (page: Page, n: number) =>
  expect(tokens(page)).toHaveAttribute("data-value", String(n));
const pick = (page: Page, group: "Period" | "Provider", option: string) =>
  page
    .getByRole("radiogroup", { name: group, exact: true })
    .getByRole("radio", { name: option, exact: true })
    .click();
const openDetail = (page: Page, summary: string | RegExp) =>
  page.locator("summary", { hasText: summary }).click();

test("Usage navigation, server period/provider filters, chart/table agreement and detail filters", async ({
  page,
}) => {
  await seed(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.gramMock?.getSettings())?.onboarding.lastSeenVersion),
    )
    .toBe("1.0.0-mock");
  const settingsBefore = await page.evaluate(() => window.gramMock!.getSettings());
  // The title bar's meter, then its popover's link: usage's one way in.
  await page.getByTestId("usage-meter").click();
  await page.getByTestId("usage-limits-page").focus();
  await page.keyboard.press("Enter");
  // Settings → Usage, the limits, links on to the tokens.
  await expect(page).toHaveURL(/\/settings\/usage$/);
  await page.getByTestId("usage-settings-tokens").click();
  await expect(page).toHaveURL(/\/usage$/);
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  // Thirty days to begin with; the flow below starts from seven.
  await expectTokens(page, 2_340_000);
  await pick(page, "Period", "7 d");
  await expectTokens(page, 468_000);
  await expect(tokens(page)).toHaveText("468K");
  await expect(tokens(page)).toHaveAttribute("title", "468,000 tokens");
  await expect(page.getByTestId("usage-turns")).toHaveText("42");
  await page.getByText("Daily values (UTC)", { exact: true }).click();
  const chartTable = page.getByRole("table", {
    name: "Daily token activity, including days with no counted tokens",
  });
  const sum = await chartTable
    .locator("tbody tr")
    .evaluateAll((rows) =>
      rows.reduce(
        (n, row) => n + Number(row.lastElementChild?.textContent?.replaceAll(",", "")),
        0,
      ),
    );
  expect(sum).toBe(468000);
  await openDetail(page, "Model and day detail");
  const modelTable = page.getByTestId("usage-model-table");
  expect(
    await modelTable
      .locator("tbody tr")
      .evaluateAll((rows) =>
        rows.reduce(
          (n, row) => n + Number(row.lastElementChild?.textContent?.replaceAll(",", "")),
          0,
        ),
      ),
  ).toBe(sum);
  await page.getByLabel("Table model", { exact: true }).selectOption("null");
  await expect(modelTable.locator("tbody tr")).toHaveCount(7);
  await page.getByLabel("Table day", { exact: true }).selectOption("2026-10-12");
  await expect(modelTable.locator("tbody tr")).toHaveCount(1);
  await pick(page, "Provider", "Claude");
  await expectTokens(page, 306_000);
  await expect(page.getByTestId("usage-turns")).toHaveText("21");
  await expect(modelTable.locator("tbody tr")).toHaveCount(7);
  await expect(modelTable).not.toContainText("Unknown model");
  // Both filters go back to the server: the period and the provider together.
  await pick(page, "Period", "24 h");
  await expectTokens(page, 17_000);
  await pick(page, "Provider", "All");
  await expectTokens(page, 26_000);
  const period = page.getByRole("radiogroup", { name: "Period", exact: true });
  await period.getByRole("radio", { name: "90 d" }).focus();
  await page.keyboard.press("Tab");
  await expect(
    page
      .getByRole("radiogroup", { name: "Provider", exact: true })
      .getByRole("radio", { name: "All" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/usage$/);
  expect(await page.evaluate(() => window.gramMock!.getSettings())).toEqual(settingsBefore);
});

test("history switches save usageHistory and read the overview again", async ({ page }) => {
  await seed(page);
  await page.goto("/usage");
  await expectTokens(page, 2_340_000);
  const codex = page.getByRole("switch", { name: "Codex history" });
  const claude = page.getByRole("switch", { name: "Claude Code history" });
  await expect(codex).toBeChecked();
  await expect(claude).toBeChecked();
  // What the server would count without Codex's local history: a different snapshot.
  await page.evaluate(() => sessionStorage.setItem("gram.mock.usage", "zero"));
  await codex.click();
  await expect(codex).not.toBeChecked();
  await expect
    .poll(() => page.evaluate(async () => (await window.gramMock!.getSettings()).usageHistory))
    .toEqual({ codex: false });
  // Saved, then the overview is read again: no Refresh pressed.
  await expectTokens(page, 0);
  await codex.click();
  await expect
    .poll(() => page.evaluate(async () => (await window.gramMock!.getSettings()).usageHistory))
    .toEqual({ codex: true });
  await expect(claude).toBeChecked();
});
