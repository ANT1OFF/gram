import { expect, test, type Page } from "@playwright/test";
import { openOrchestrator, threadRow } from "./thread-row";

// The usage meter after a reload, its forecast and ages, the per-workspace pause threshold, and
// the pause ask. The limits are the mock's invented readings (`api/mock-limits.ts`), which it keeps
// in sessionStorage as the server keeps them in its database; never a live account's.

const seed = (page: Page, flags: Record<string, string>) =>
  page.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) {
      if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, value);
    }
  }, flags);

test.use({ timezoneId: "UTC" });

const CLOCK = "\\d{2}:\\d{2}";

test("the meter shows the kept readings again after a reload", async ({ page }) => {
  await seed(page, { "gram.mock.limits": "none" });
  await page.goto("/t/t-flaky");
  // The mock is imported lazily (`createApi`), so `window.gramMock` lands a moment after `goto`.
  await page.waitForFunction(() => window.gramMock !== undefined);
  const meter = page.getByTestId("usage-meter");
  await expect(meter).toHaveCount(0);
  await page.evaluate(() =>
    window.gramMock!.simulateUsageLimit({
      agent: "claude",
      window: "five_hour",
      utilization: 0.64,
      resetsAt: Date.now() + 2 * 3_600_000,
    }),
  );
  await expect(meter).toHaveAccessibleName(/Claude Code 5-hour 64%$/);

  await page.reload();
  // No agent has reported since: the meter comes from the replay alone.
  await expect(meter).toHaveAccessibleName(/Claude Code 5-hour 64%$/);
});

test("the popover forecasts a window that is filling, and dates a reading gone quiet", async ({
  page,
}) => {
  // The forecast is ahead of now; keep its bare-clock assertion on the same day.
  await page.clock.setFixedTime(new Date("2026-10-18T12:00:00Z"));
  await page.goto("/t/t-flaky");
  await page.getByTestId("usage-meter").click();
  const popover = page.getByRole("dialog", { name: "Subscription usage" });

  // Codex's 5-hour window rose 15 points in the last hour, so it reaches 90% before its reset.
  const codex = popover.getByRole("region", { name: "Codex" });
  await expect(codex.getByTestId("usage-limit-forecast")).toHaveText(
    new RegExp(`^Estimate at recent pace: 90% around ${CLOCK}$`),
  );
  await expect(codex.getByTestId("usage-limit-age")).toHaveText(/^Updated (just now|\d+m ago)$/);
  await expect(codex.getByTestId("usage-limit-age")).not.toHaveAttribute("data-stale", "true");

  // Claude's readings are 40 minutes old, and too slow to forecast.
  const claude = popover.getByRole("region", { name: "Claude Code" });
  // An old reading says so in its age's own muted words, on its name's row and in the Resets
  // column, never as a mark that reads as a button, and keeps its figures at full strength.
  await expect(claude.getByTestId("usage-limit-age")).toHaveText("Old reading · 40m ago");
  await expect(claude.getByTestId("usage-limit-age")).toHaveAttribute("data-stale", "true");
  // The provider's name and its age each keep one line.
  for (const part of [claude.getByRole("heading"), claude.getByTestId("usage-limit-age")]) {
    const box = (await part.boundingBox())!;
    // One line is 20 to 24 px; a wrapped second line would make it 40 or more.
    expect(box.height).toBeLessThan(32);
  }
  const rowOpacity = await claude
    .getByTestId("usage-limit-row")
    .first()
    .evaluate((el) => getComputedStyle(el).opacity);
  expect(rowOpacity).toBe("1");
  await expect(claude.getByTestId("usage-limit-forecast")).toHaveCount(0);

  // Each provider dates its reading the same way, in muted words: an old one is no amber alarm.
  const ages = popover.getByTestId("usage-limit-age");
  const colours = await ages.evaluateAll((all) => all.map((el) => getComputedStyle(el).color));
  expect(new Set(colours).size).toBe(1);
  // The window the title bar shows is marked, and named at the head: on this Claude thread,
  // Claude's closest, though Codex's is higher. The thread's agent's block says so, and the foot
  // says the one rule the meter follows everywhere.
  await expect(claude.locator('[data-testid="usage-limit-row"][data-shown]')).toHaveAttribute(
    "data-window",
    "weekly",
  );
  await expect(codex.locator('[data-testid="usage-limit-row"][data-shown]')).toHaveCount(0);
  await expect(popover.getByTestId("usage-limits-source")).toHaveText(
    "In the title bar: This thread: Claude Code weekly 61%",
  );
  await expect(claude.getByTestId("usage-limit-this-thread")).toHaveText("This thread");
  await expect(codex.getByTestId("usage-limit-this-thread")).toHaveCount(0);
  await expect(popover.getByTestId("usage-limits-foot")).toContainText(
    "On a thread, the title bar shows its agent's closest limit",
  );
  // Off a thread, it is the highest of all, and says so, by the same rule.
  await page.keyboard.press("Escape");
  await page.goto("/usage");
  await page.getByTestId("usage-meter").click();
  await expect(popover.getByTestId("usage-limits-source")).toHaveText(
    "In the title bar: Highest: Codex 5-hour 85%",
  );
  await expect(popover.getByTestId("usage-limit-this-thread")).toHaveCount(0);
});

test("the popover says each row's use and reset, and shows the credits an agent reports", async ({
  page,
}) => {
  // This checks a same-day reset alongside the dated weekly reset.
  await page.clock.setFixedTime(new Date("2026-10-18T12:00:00Z"));
  await page.goto("/t/t-flaky");
  await page.waitForFunction(() => window.gramMock !== undefined);
  await page.evaluate(() =>
    window.gramMock!.simulateUsageLimit({
      agent: "codex",
      window: "five_hour",
      utilization: 0.4,
      resetsAt: Date.now() + 2 * 3_600_000,
      creditsAvailable: true,
      creditsBalance: "1250",
    }),
  );
  await page.getByTestId("usage-meter").click();
  const popover = page.getByRole("dialog", { name: "Subscription usage" });
  const codex = popover.getByRole("region", { name: "Codex" });
  await expect(
    codex.locator('[data-window="fiveHour"]').getByTestId("usage-limit-used"),
  ).toHaveText("40%");
  await expect(
    codex.locator('[data-window="fiveHour"]').getByTestId("usage-limit-reset"),
  ).toHaveText(/^\d{2}:\d{2}$/);
  await expect(codex.getByTestId("usage-provider-credits")).toHaveText("On credits · 1,250 left");
  // A weekly reset days away carries its date, not just a time that could be today's: the shared
  // stamp, "8 Nov 07:45".
  await expect(
    popover
      .getByRole("region", { name: "Claude Code" })
      .locator('[data-window="weekly"]')
      .getByTestId("usage-limit-reset"),
  ).toHaveText(/^\d{1,2} [A-Z][a-z]{2}( \d{4})? \d{2}:\d{2}$/);
});

test("a workspace sets the share of a limit at which new workers pause", async ({ page }) => {
  await page.goto("/settings/workspaces");
  await page.waitForFunction(() => window.gramMock !== undefined);
  await page.evaluate(async () => {
    const api = window.gramMock!;
    const project = (await api.listProjects())[0]!;
    await api.saveWorkspace({
      name: "Limits fixture",
      projectIds: [project.id],
      homeProjectId: project.id,
    });
  });
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "General", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Workspaces & merging", exact: true })
    .click();
  await page
    .getByRole("listitem", { name: "Workspace Limits fixture" })
    .getByTestId("workspace-link")
    .click();

  const row = page.getByTestId("pause-at-limit");
  await expect(row).toHaveAttribute("data-value", "off");
  await expect(row).toContainText("Pause new workers at");
  // The tightest reading now, beside the choice.
  await expect(row).toContainText("Codex 85% used now");
  await row.getByRole("radio", { name: "90%" }).click();
  await expect(row).toHaveAttribute("data-value", "90");
  const saved = await page.evaluate(async () => {
    const all = await window.gramMock!.listWorkspaces();
    return all.find((each) => each.workspace.name === "Limits fixture")?.charter.pauseAtLimitPct;
  });
  expect(saved).toBe(90);
});

test.describe("midday reset fixture", () => {
  test.use({ timezoneId: "Europe/Oslo" });
  test("the pause ask offers to pause until the reset, or keep going", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-10-18T10:00:00Z") });
    await page.goto("/t/t-flaky");
    await expect(threadRow(page, "t-flaky")).toBeVisible();
    const made = await page.evaluate(() => window.gramMock!.simulateAsks());
    await page.evaluate(
      ({ threadId }) =>
        window.gramMock!.simulateRequest(threadId, {
          kind: "approval",
          id: "limit-ask",
          toolName: "mcp__gram__limit_pause",
          displayName: "new workers",
          input: {
            agent: "claude",
            window: "five_hour",
            usedPct: 92,
            pauseAtPct: 90,
            resetsAt: Date.now() + 2 * 3_600_000,
          },
          description: "Claude's 5-hour limit is at 92%.",
          suggestions: [],
          scopes: ["once"],
        } as never),
      { threadId: made.orchestratorThreadId },
    );
    await openOrchestrator(page, made.orchestratorThreadId);
    await page.getByTestId("overview-needs-you").click();
    await page.getByTestId("inbox-item").filter({ hasText: "Claude is at 92%" }).click();
    const ask = page.getByTestId("inbox-detail").getByTestId("ask-item");
    await expect(ask).toContainText("Claude is at 92% of its 5-hour limit");
    await expect(ask).toContainText(
      new RegExp(`Pause new workers until it resets at ${CLOCK}\\? Running ones finish\\.`),
    );
    const pause = ask.getByRole("button", { name: new RegExp(`^Pause until ${CLOCK}`) });
    await expect(pause).toBeVisible();
    await expect(ask.getByRole("button", { name: /^Keep going/ })).toBeVisible();
  });
});
