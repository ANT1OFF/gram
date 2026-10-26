import { expect, test, type Page } from "@playwright/test";
import { seedTheme } from "./seed-theme";

const seed = (page: Page, state = "sample") =>
  page.addInitScript((value) => {
    sessionStorage.setItem("gram.mock.usage", value);
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        tools: [
          { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.296" },
          { tool: "codex", found: true, path: "/mock/bin/codex", version: "0.162.1" },
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
const total = (list: number[]) => list.reduce((n, x) => n + x, 0);
const openDetail = (page: Page, summary: string | RegExp) =>
  page.locator("summary", { hasText: summary }).click();

test("Usage navigation, server period/provider filters, chart/table agreement and detail filters", async ({
  page,
}, info) => {
  await seed(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.gramMock?.getSettings())?.onboarding.lastSeenVersion),
    )
    .toBe("1.0.0-mock");
  const settingsBefore = await page.evaluate(() => window.gramMock!.getSettings());
  const usageLink = page.getByRole("button", { name: "Usage", exact: true });
  await usageLink.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  // Thirty days to begin with; the flow below starts from seven.
  await expectTokens(page, 2_340_000);
  await pick(page, "Period", "7 d");
  await expectTokens(page, 468_000);
  await expect(tokens(page)).toHaveText("468K");
  await expect(tokens(page)).toHaveAttribute("title", "468,000 tokens");
  await expect(page.getByTestId("usage-turns")).toHaveText("42");
  await openDetail(page, /^Coverage/);
  await expect(
    page.getByText("Claude Code and Codex recordings can omit main-lane model metadata.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("1 turns in the period have unknown or unsupported providers", { exact: false }),
  ).toBeVisible();
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
  await expect(page.getByText("Filter this table · 162,000 known tokens in 7 rows")).toBeVisible();
  await page.getByLabel("Table day", { exact: true }).selectOption("2026-10-12");
  await expect(modelTable.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByText("Filter this table · 9,000 known tokens in 1 rows")).toBeVisible();
  await pick(page, "Provider", "Claude");
  await expectTokens(page, 306_000);
  await expect(page.getByTestId("usage-turns")).toHaveText("21");
  await expect(modelTable.locator("tbody tr")).toHaveCount(7);
  await expect(modelTable).not.toContainText("Unknown model");
  await pick(page, "Period", "24 h");
  await expectTokens(page, 17_000);
  await pick(page, "Provider", "All");
  await expectTokens(page, 26_000);
  await pick(page, "Period", "30 d");
  await expectTokens(page, 2_340_000);
  await expect(modelTable).toContainText("claude-example-old");
  await pick(page, "Period", "90 d");
  await expectTokens(page, 7_020_000);
  await pick(page, "Period", "7 d");
  await expectTokens(page, 468_000);
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
  await page.screenshot({ path: info.outputPath("usage-dark-wide.png"), fullPage: true });
});

for (const [mode, width, motion] of [
  ["light", 1440, "off"],
  ["dark", 620, "reduced"],
  ["light", 620, "off"],
] as const) {
  test(`Usage ${mode} ${width}px ${motion} remains readable with bounded horizontal table scrolling`, async ({
    page,
  }, info) => {
    await seed(page);
    await page.addInitScript(
      ({ mode: seededMode, motion: seededMotion }) => {
        sessionStorage.setItem(
          "gram.mock.settings",
          JSON.stringify({
            appearance: {
              mode: seededMode,
              motion: seededMotion,
              paletteId: seededMode === "light" ? "catppuccin-latte" : "catppuccin-mocha",
            },
          }),
        );
      },
      { mode, motion },
    );
    await seedTheme(page, {
      mode,
      motion,
      palette: mode === "light" ? "catppuccin-latte" : "catppuccin-mocha",
    });
    await page.setViewportSize({ width, height: 1100 });
    await page.goto("/usage");
    await page.getByTestId("launch-checks-banner").getByRole("button", { name: "Dismiss" }).click();
    // Narrow, the overview's rail is hidden, so Usage has the window's whole width.
    if (width < 700) await page.getByTestId("overview-hide").click();
    await expectTokens(page, 2_340_000);
    await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
    await openDetail(page, /^Coverage/);
    await openDetail(page, "Model and day detail");
    await openDetail(page, "Daily values (UTC)");
    expect(
      await page.getByTestId("usage-overview").evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await expect(page.getByRole("radiogroup", { name: "Period", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recording coverage" })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`usage-${mode}-${width}.png`), fullPage: true });
  });
}

test("empty first use, known zero and failed read are distinct; retry is manual", async ({
  page,
}) => {
  await seed(page, "empty");
  await page.goto("/usage");
  await expect(
    page.getByRole("heading", { name: "No recorded activity in this period" }),
  ).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem("gram.mock.usage", "zero"));
  await page.getByRole("button", { name: "Refresh usage" }).click();
  // Thirty days of three zero-token turns per provider.
  await expect(page.getByTestId("usage-turns")).toHaveText("180");
  await expectTokens(page, 0);
  await expect(tokens(page)).toHaveText("0");
  await expect(page.getByTestId("usage-chart")).toBeVisible();
  await expect(page.getByText(/NaN|Infinity/)).toHaveCount(0);
  await page.evaluate(() => sessionStorage.setItem("gram.mock.usage", "error"));
  await page.getByRole("button", { name: "Refresh usage" }).click();
  await expect(page.getByRole("heading", { name: "Usage unavailable" })).toBeVisible();
  await expect(page.getByTestId("usage-tokens")).toHaveCount(0);
  await page.evaluate(() => sessionStorage.setItem("gram.mock.usage", "sample"));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expectTokens(page, 2_340_000);
});

// Production preview with explicit signed-out tools; states mirror the production SQLite oracle.
test("large-body accounting before/after and genuine accounting refusal render distinctly", async ({
  page,
}, info) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (e) => {
    if (e.type() === "error") consoleErrors.push(e.text());
  });
  await seed(page, "payload-budget-before");
  await page.goto("/usage");
  await page.getByTestId("launch-checks-banner").getByRole("button", { name: "Dismiss" }).click();
  await pick(page, "Period", "24 h");
  await expect(page.getByRole("heading", { name: "Usage unavailable" })).toBeVisible();
  await expect(page.getByText(/1 MiB per message/)).toBeVisible();
  await expect(page.getByTestId("usage-tokens")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("usage-large-history-before.png"),
    fullPage: true,
  });
  await page.evaluate(() => sessionStorage.setItem("gram.mock.usage", "large-history"));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expectTokens(page, 6_000);
  await expect(page.getByTestId("usage-turns")).toHaveText("40");
  await openDetail(page, "Model and day detail");
  const table = page.getByTestId("usage-model-table");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table).toContainText("Unknown model");
  await page.screenshot({ path: info.outputPath("usage-large-history-after.png"), fullPage: true });
  await page.evaluate(() => sessionStorage.setItem("gram.mock.usage", "payload-budget-refusal"));
  await page.getByRole("button", { name: "Refresh usage" }).click();
  await expect(page.getByText(/1 MiB per attribution projection/)).toBeVisible();
  await expect(page.getByTestId("usage-tokens")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("usage-accounting-refusal-after.png"),
    fullPage: true,
  });
  expect(pageErrors).toEqual([]);
  await info.attach("console-errors.json", {
    body: JSON.stringify(consoleErrors),
    contentType: "application/json",
  });
});

// Visual fixtures mirror the production older-history oracle, not a private account or CLI scan.
test("older CLI history, actual model filters, refresh and excluded uncertain amounts", async ({
  page,
}, info) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await seed(page, "history-before");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/usage");
  await page.getByTestId("launch-checks-banner").getByRole("button", { name: "Dismiss" }).click();
  await expectTokens(page, 0);
  await expect(
    page.getByRole("heading", { name: "No recorded activity in this period" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("usage-history.before.png"), fullPage: true });
  await page.evaluate(() => sessionStorage.setItem("gram.mock.usage", "history-after"));
  await page.getByRole("button", { name: "Refresh usage" }).click();
  await expectTokens(page, 227);
  await expect(page.getByTestId("usage-turns")).toHaveText("3");
  await openDetail(page, "Model and day detail");
  const table = page.getByTestId("usage-model-table");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table).toContainText("2026-10-06");
  await expect(table).toContainText("gpt-offline-old");
  await expect(table).toContainText("gpt-offline-new");
  await expect(table).toContainText("claude-offline-old");
  await expect(page.getByTestId("usage-history-coverage")).toContainText(
    "3 CLI usage records added",
  );
  await page.screenshot({ path: info.outputPath("usage-history.after.png"), fullPage: true });
  await page
    .getByLabel("Table model", { exact: true })
    .selectOption(JSON.stringify("gpt-offline-old"));
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByText("Filter this table · 110 known tokens in 1 rows")).toBeVisible();
  await pick(page, "Provider", "Claude");
  await expectTokens(page, 32);
  await pick(page, "Provider", "All");
  await page.evaluate(() => sessionStorage.setItem("gram.mock.usage", "history-partial"));
  await page.getByRole("button", { name: "Refresh usage" }).click();
  await expect(page.getByTestId("usage-history-coverage")).toContainText(
    "1 Codex turns without request telemetry have untrusted amounts and are excluded",
  );
  await expect(page.getByTestId("usage-history-coverage")).toContainText(
    "1 Gram turns have ambiguous identity overlap and are excluded",
  );
  await expectTokens(page, 227);
  await openDetail(page, /^Coverage/);
  await page.getByRole("heading", { name: "Local history coverage" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("usage-history.partial.png"), fullPage: true });
  await page.evaluate(() => sessionStorage.setItem("gram.mock.usage", "history-untrusted-only"));
  await page.getByRole("button", { name: "Refresh usage" }).click();
  await expect(tokens(page)).toHaveText("—");
  await expect(tokens(page)).not.toHaveAttribute("data-value");
  await expect(
    page.getByText(
      "Activity exists, but no attributable token totals are available for this selection.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No recorded activity in this period" }),
  ).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

// The mock's invented limit readings (`api/mock-limits.ts`): Claude read 40 minutes ago, Codex's
// 5-hour window at 85% and rising. Never a live account's.
test.describe("midday reset fixture", () => {
  test.use({ timezoneId: "Europe/Oslo" });
  test("limit cards: share, 24-hour reset, forecast, warning, and the provider filter", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-10-18T10:00:00Z") });
    await seed(page);
    await page.goto("/usage");
    const cards = page.getByTestId("usage-limit-card");
    await expect(cards).toHaveCount(4);
    const codex = page.getByRole("group", { name: "Codex 5-hour limit" });
    await expect(codex).toHaveAttribute("data-warn", "true");
    await expect(codex.getByTestId("usage-limit-percent")).toHaveText("85%");
    await expect(codex.getByRole("meter")).toHaveAttribute("aria-valuenow", "85");
    await expect(codex.getByTestId("usage-limit-reset")).toHaveText(/^Resets \d{2}:\d{2}$/);
    await expect(codex.getByTestId("usage-limit-forecast")).toHaveText(
      /^At this pace you reach 90% around \d{2}:\d{2}$/,
    );
    await expect(codex.getByTestId("usage-limit-reach")).toBeVisible();
    const claudeWeekly = page.getByRole("group", { name: "Claude Code weekly limit" });
    await expect(claudeWeekly).not.toHaveAttribute("data-warn");
    await expect(claudeWeekly.getByTestId("usage-limit-reset")).toHaveText(
      /^Resets [A-Z][a-z]{2} \d{2}:\d{2}$/,
    );
    await expect(claudeWeekly.getByTestId("usage-limit-age")).toHaveText("Read 40m ago");
    await pick(page, "Provider", "Codex");
    await expect(cards).toHaveCount(2);
    await expect(page.getByRole("group", { name: "Claude Code 5-hour limit" })).toHaveCount(0);
  });
});

test("no readings yet: one line in place of the cards", async ({ page }) => {
  await seed(page);
  await page.addInitScript(() => sessionStorage.setItem("gram.mock.limits", "none"));
  await page.goto("/usage");
  await expectTokens(page, 2_340_000);
  await expect(page.getByTestId("usage-limit-card")).toHaveCount(0);
  await expect(page.getByTestId("usage-limits-none")).toHaveText(
    "Limits appear here once Claude Code or Codex reports one.",
  );
});

test("the breakdown sums to the total, follows the provider filter, and opens a thread", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/usage");
  const amounts = (testId: string) =>
    page
      .getByTestId(testId)
      .getByTestId("usage-amount")
      .evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-value"))));
  const outside = () =>
    page
      .getByTestId("usage-outside-provider")
      .evaluateAll((els) =>
        els.map((el) =>
          Number(el.querySelector("[title]")!.getAttribute("title")!.replace(/\D/g, "")),
        ),
      );
  await expectTokens(page, 2_340_000);
  const workspaces = page.getByTestId("usage-by-workspace").getByTestId("usage-breakdown-row");
  await expect(workspaces).toHaveCount(2);
  await expect(workspaces.first()).toContainText("Invented workspace");
  await expect(workspaces.first()).toContainText("2 threads");
  await expect(workspaces.nth(1)).toContainText("Solo threads");
  await expect(page.getByTestId("usage-outside")).toBeVisible();
  expect(total(await amounts("usage-by-workspace")) + total(await outside())).toBe(2_340_000);
  const threads = page.getByTestId("usage-thread-row");
  await expect(threads.first()).toContainText("Orchestrator · Invented");
  await expect(threads.first()).toContainText("orchestrator");

  await pick(page, "Provider", "Claude");
  await expectTokens(page, 1_530_000);
  await expect(page.getByTestId("usage-outside")).toHaveCount(0);
  await expect(
    page.getByTestId("usage-by-workspace").getByTestId("usage-breakdown-row"),
  ).toHaveCount(1);
  expect(total(await amounts("usage-by-workspace"))).toBe(1_530_000);

  await pick(page, "Provider", "All");
  await page
    .getByTestId("usage-thread-row")
    .filter({ hasText: "Fix flaky retry test" })
    .getByRole("link")
    .click();
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
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

test("Codex's limit history draws under its window, and only with history", async ({ page }) => {
  await seed(page, "showcase");
  await page.goto("/usage");
  const codex = page.getByRole("group", { name: "Codex 5-hour limit" });
  await expect(codex.getByTestId("usage-limit-history")).toHaveAttribute(
    "aria-label",
    "Codex 5-hour limit, last 24 hours, from local history",
  );
  await expect(
    page
      .getByRole("group", { name: "Claude Code 5-hour limit" })
      .getByTestId("usage-limit-history"),
  ).toHaveCount(0);
  await expect(page.getByTestId("usage-chart-day")).toHaveCount(31);
  await page.getByTestId("usage-chart-day").nth(20).hover();
  await expect(page.getByTestId("usage-chart-tip")).toContainText("Total");
  await pick(page, "Provider", "Claude");
  await expect(page.getByTestId("usage-limit-history")).toHaveCount(0);
});
