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
  await expect(meter).toHaveText("Claude 64%");

  await page.reload();
  // No agent has reported since: the meter comes from the replay alone.
  await expect(meter).toHaveText("Claude 64%");
});

test("the popover forecasts a window that is filling, and dates a reading gone quiet", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  await page.getByTestId("usage-meter").click();
  const popover = page.getByRole("dialog", { name: "Subscription usage" });

  // Codex's 5-hour window rose 15 points in the last hour, so it reaches 90% before its reset.
  const codex = popover.getByRole("region", { name: "Codex" });
  await expect(codex.getByTestId("usage-limit-forecast")).toHaveText(
    new RegExp(`^At this pace you reach 90% around ${CLOCK}$`),
  );
  await expect(codex.getByTestId("usage-limit-age")).toHaveCount(0);

  // Claude's readings are 40 minutes old, and too slow to forecast.
  const claude = popover.getByRole("region", { name: "Claude Code" });
  await expect(claude.getByTestId("usage-limit-age")).toHaveText("40m ago");
  await expect(claude.getByTestId("usage-limit-forecast")).toHaveCount(0);
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
    .getByRole("link", { name: "Workspaces", exact: true })
    .click();
  await page
    .getByRole("listitem", { name: "Workspace Limits fixture" })
    .getByTestId("workspace-link")
    .click();

  const row = page.getByTestId("pause-at-limit");
  await expect(row).toHaveAttribute("data-value", "off");
  await expect(row).toContainText("Pause new workers at");
  // The tightest reading now, beside the choice.
  await expect(row).toContainText("Codex 85% now");
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
    const stack = page.getByTestId("ask-stack");
    const ask = stack.getByTestId("ask-item").filter({ hasText: "Claude is at 92%" });
    await expect(ask).toContainText("Claude is at 92% of its 5-hour limit");
    await expect(ask).toContainText(
      new RegExp(`Pause new workers until it resets at ${CLOCK}\\? Running ones finish\\.`),
    );
    const pause = ask.getByRole("button", { name: new RegExp(`^Pause until ${CLOCK}`) });
    await expect(pause).toBeVisible();
    await expect(ask.getByRole("button", { name: /^Keep going/ })).toBeVisible();
  });
});
