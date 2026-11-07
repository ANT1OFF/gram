import { expect, test, type Page } from "@playwright/test";

import { flakyAsked } from "./seed-asks";

// The title bar's subscription meter, and a launch that lands on the orchestrator. The limits are
// the mock's invented readings (`api/mock-limits.ts`), never a live account's.

const seed = (page: Page, flags: Record<string, string>) =>
  page.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) sessionStorage.setItem(key, value);
  }, flags);

const WELCOME_UNSEEN = JSON.stringify({ onboarding: { welcomeSeen: false } });

const RESETS = /^(\d{1,2} [A-Z][a-z]{2}( \d{4})? )?\d{2}:\d{2}$/;

test("the meter shows the thread's agent's limit and opens onto both providers", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const meter = page.getByTestId("usage-meter");
  // A Claude thread shows Claude's closest window (weekly, 61%), not Codex's higher 85%: the meter
  // names the agent the composer names. Icon-only, the reading is its name's and its hover's; short
  // of the warning it has no dot, so the title bar's only amber stays what needs you.
  await expect(meter).toHaveText("");
  await expect(meter).not.toHaveAttribute("data-warn");
  await expect(meter.getByTestId("usage-meter-dot")).toHaveCount(0);
  await expect(meter).toHaveAccessibleName(
    "Subscription usage. This thread: Claude Code weekly 61%",
  );
  // Open, the popover gives way to the approval card: let the thread's opening turn raise it.
  await flakyAsked(page);

  await meter.click();
  const popover = page.getByRole("dialog", { name: "Subscription usage" });
  await expect(popover).toBeVisible();
  // The columns are named once, so the rows line up under them without repeating the words.
  await expect(popover.getByTestId("usage-limits-columns")).toHaveText(/^\s*Used\s*Resets\s*$/);
  for (const [provider, rows] of [
    ["Claude Code", ["42%", "61%"]],
    ["Codex", ["85%", "30%"]],
  ] as const) {
    const section = popover.getByRole("region", { name: provider });
    await expect(section.getByRole("heading")).toHaveText(provider);
    const windows = section.getByTestId("usage-limit-row");
    await expect(windows).toHaveCount(2);
    for (const [i, label] of ["5-hour", "Weekly"].entries()) {
      const cells = windows.nth(i).locator(":scope > span:not([aria-hidden])");
      // Each row says its period, the share used and when it resets, under the columns' names,
      // and all three in words in its name.
      await expect(cells.nth(0)).toHaveText(label);
      await expect(cells.nth(1)).toHaveText(rows[i]!);
      await expect(windows.nth(i)).toHaveAccessibleName(
        new RegExp(`^${label}: ${rows[i]!} used, resets `),
      );
      // Resets on a 24-hour clock: today's as a time, later ones with their date before it.
      await expect(cells.nth(2)).toHaveText(RESETS);
    }
  }
  await expect(popover).toContainText("Includes your own use outside Gram.");
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // Open, it gives way once focus moves to the conversation (an approval card's buttons, the
  // composer), so it never sits over the card that asks.
  await meter.click();
  await expect(popover).toBeVisible();
  await page.getByLabel("Message", { exact: true }).focus();
  await expect(popover).toBeHidden();
  await meter.click();
  await expect(popover).toBeVisible();
  await page
    .getByRole("button", { name: /^Allow once/ })
    .first()
    .focus();
  await expect(popover).toBeHidden();
});

test("the popover drops clear of the approval card it would cover", async ({ page }) => {
  // A real window's size, the right panel open beside the chat as a review has it.
  await page.setViewportSize({ width: 1728, height: 1095 });
  await page.goto("/t/t-flaky");
  // The mock is imported lazily, so `window.gramMock` lands a moment after `goto`.
  await page.waitForFunction(() => window.gramMock !== undefined);
  await flakyAsked(page);
  const card = page.getByTestId("approval-card").first();
  await expect(card).toBeVisible();
  const meter = page.getByTestId("usage-meter");
  await meter.click();
  const popover = page.getByRole("dialog", { name: "Subscription usage" });
  await expect(popover).toBeVisible();
  // Wide enough for a provider's name, its age and a dated reset on one line each.
  const box = (await popover.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(370);
  const ask = (await card.boundingBox())!;
  const overlaps =
    box.x < ask.x + ask.width &&
    ask.x < box.x + box.width &&
    box.y < ask.y + ask.height &&
    ask.y < box.y + box.height;
  expect(overlaps).toBe(false);
  // The card's buttons stay where a click lands on them, not on the popover.
  const allow = card.getByRole("button", { name: /^Allow once/ });
  const target = (await allow.boundingBox())!;
  const hit = await page.evaluate(
    ({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('[data-testid="approval-card"]') !== null,
    { x: target.x + target.width / 2, y: target.y + target.height / 2 },
  );
  expect(hit).toBe(true);
});

test("the title bar's meter is an icon button on an orchestrator, a worker and a narrow bar", async ({
  page,
}) => {
  await seed(page, { "gram.mock.orchestration": "board" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  // A launch with a workspace lands on its orchestrator.
  await expect(page).toHaveURL(/\/t\/t-mock-\d+$/);
  await page.waitForFunction(() => window.gramMock !== undefined);
  // Codex's 5-hour window spent, carried on credits: past the warning, so the meter shows it.
  await page.evaluate(() =>
    window.gramMock!.simulateUsageLimit({
      agent: "codex",
      window: "five_hour",
      utilization: 1,
      resetsAt: Date.now() + 3_600_000,
      credits: true,
      creditsAvailable: true,
      creditsBalance: "100",
    }),
  );
  const bar = page.getByTestId("shell-titlebar");
  const meter = bar.getByTestId("usage-meter");
  const hint = page.locator('[data-slot="tooltip-content"][data-open]');

  // A hint opens only for a pointer that moved onto its trigger, never for a trigger that moved under
  // a resting one (DESIGN.md). After a navigation or a resize the bar lays out again (its fold, the
  // grid's width transition), so the button is hovered once it has stopped moving, as a person's
  // pointer would reach it.
  const settled = () =>
    expect
      .poll(
        async () => {
          const before = await meter.boundingBox();
          await page.waitForTimeout(150);
          const after = await meter.boundingBox();
          return before !== null && after !== null && before.x === after.x && before.y === after.y;
        },
        { message: "the usage button stops moving" },
      )
      .toBe(true);

  const readsAsButton = async () => {
    await expect(meter).toBeVisible();
    await settled();
    // Usage's glyph alone, a toolbar icon button's 28 px square like the bar's others, with no bar
    // and no words: the reading is its hover's and its name's, the state a dot on its corner.
    await expect(meter.locator("svg.lucide-chart-no-axes-combined")).toBeVisible();
    await expect(meter).toHaveText("");
    await expect(meter.getByTestId("usage-meter-fill")).toHaveCount(0);
    const box = (await meter.boundingBox())!;
    expect(Math.round(box.width)).toBe(28);
    expect(Math.round(box.height)).toBe(28);
    await expect(meter).toHaveAttribute("data-state", "credits");
    await expect(meter.getByTestId("usage-meter-dot")).toBeVisible();
    await expect(meter).toHaveAccessibleName(
      "Subscription usage, limit reached, continuing on credits. Highest: Codex 5-hour 100% · on credits",
    );
    await meter.hover();
    await expect(hint).toContainText("Codex 5-hour 100% · on credits");
    // And it is a button: a click opens every provider's limits.
    await meter.click();
    const popover = page.getByRole("dialog", { name: "Subscription usage" });
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await page.mouse.move(0, 450);
  };

  await readsAsButton();
  // A worker's bar.
  await page.goto("/t/t-flaky");
  await readsAsButton();
  // A narrow bar keeps the button.
  await page.setViewportSize({ width: 900, height: 800 });
  await readsAsButton();
});

test("an orchestrator's title bar has Memory beside Chat · Board", async ({ page }) => {
  await seed(page, { "gram.mock.orchestration": "board" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page).toHaveURL(/\/t\/t-mock-\d+$/);
  const workspaceId = await page.evaluate(
    async () => (await window.gramMock!.listWorkspaces())[0]!.workspace.id,
  );
  const bar = page.getByTestId("shell-titlebar");
  await expect(bar.getByTestId("pane-role")).toBeVisible();
  // An icon with its name on hover, like the bar's other icons.
  const memory = bar.getByRole("link", { name: "Memory", exact: true });
  await expect(memory).toBeVisible();
  await expect(memory).toHaveText("");
  // To the right of the views and the orchestrator's glyph.
  const views = (await bar.getByTestId("view-switcher").boundingBox())!;
  const box = (await memory.boundingBox())!;
  expect(box.x).toBeGreaterThan(views.x + views.width);
  await memory.hover();
  await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText("Memory");
  await memory.click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/memory$`));
});

test("the meter waits for a limit, hints from 90% once, and ignores gateways", async ({ page }) => {
  await seed(page, { "gram.mock.limits": "none" });
  await page.goto("/t/t-flaky");
  await expect(page.getByTestId("shell-titlebar")).toBeVisible();
  const meter = page.getByTestId("usage-meter");
  await expect(meter).toHaveCount(0);

  const report = (utilization: number, extra: Record<string, unknown> = {}) =>
    page.evaluate(
      (input) =>
        window.gramMock!.simulateUsageLimit({
          agent: "claude",
          window: "five_hour",
          resetsAt: Date.now() + 2 * 3_600_000,
          ...input,
        }),
      { utilization, ...extra },
    );

  const dot = meter.getByTestId("usage-meter-dot");
  const named = (state: string, reading: string) =>
    expect(meter).toHaveAccessibleName(`Subscription usage${state}. This thread: ${reading}`);

  await report(0.5);
  await named("", "Claude Code 5-hour 50%");
  await expect(meter).not.toHaveAttribute("data-warn");
  await expect(dot).toHaveCount(0);
  await expect(page.getByTestId("pulse-once")).toHaveCount(0);

  // 85% is close, not yet a warning: the button stays plain.
  await report(0.85);
  await named("", "Claude Code 5-hour 85%");
  await expect(dot).toHaveCount(0);
  await expect(page.getByTestId("pulse-once")).toHaveCount(0);

  // Crossing 90%, a warning ring on its corner, with one pulse, and its name says so. The ring sits
  // over the glyph, so the button keeps its size.
  const size = (await meter.boundingBox())!;
  await report(0.92, { status: "warning" });
  await named(", near the limit", "Claude Code 5-hour 92%");
  await expect(meter).toHaveAttribute("data-warn", "true");
  await expect(meter).toHaveAttribute("data-state", "approaching");
  await expect(dot).toBeVisible();
  await expect(page.getByTestId("pulse-once")).toHaveCount(1);
  const after = (await meter.boundingBox())!;
  expect([after.width, after.height]).toEqual([size.width, size.height]);

  // A gateway's limit is its own quota, not the subscription's.
  await report(0.99, { gateway: true });
  await named(", near the limit", "Claude Code 5-hour 92%");

  // Codex hasn't reported, so the popover has Claude alone.
  await meter.click();
  const popover = page.getByRole("dialog", { name: "Subscription usage" });
  await expect(popover.getByRole("region", { name: "Claude Code" })).toBeVisible();
  await expect(popover.getByRole("region", { name: "Codex" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // Past the window on credits, the dot fills; spent with nothing behind it, it turns red.
  await report(1, { credits: true });
  await expect(meter).toHaveAttribute("data-state", "credits");
  await named(", limit reached, continuing on credits", "Claude Code 5-hour 100% · on credits");
  await report(1, { status: "rejected" });
  await expect(meter).toHaveAttribute("data-state", "spent");
  await named(", limit reached", "Claude Code 5-hour 100%");
});

test("a launch with a workspace lands on its orchestrator, without the welcome", async ({
  page,
}) => {
  await seed(page, {
    "gram.mock.settings": WELCOME_UNSEEN,
    "gram.mock.orchestration": "board",
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/t\/t-mock-\d+$/);
  const orchestrator = await page.evaluate(
    async () => (await window.gramMock!.listWorkspaces())[0]!.workspace.orchestratorThreadId,
  );
  expect(orchestrator).toBeDefined();
  await expect(page).toHaveURL(new RegExp(`/t/${orchestrator}$`));
  await expect(page.getByTestId("welcome")).toHaveCount(0);
});

test("a launch with no workspace stays home with the welcome", async ({ page }) => {
  await seed(page, { "gram.mock.settings": WELCOME_UNSEEN });
  await page.goto("/");
  await expect(page.getByTestId("welcome")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  // A workspace made after that launch takes the welcome away and leaves the page where it is.
  await page.evaluate(() => window.gramMock!.simulateOrchestration("board"));
  // The overview lists the new workspace.
  await expect(page.getByTestId("overview-workspace").first()).toBeVisible();
  await expect(page.getByTestId("welcome")).toHaveCount(0);
  await expect(page.getByTestId("home-empty")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

for (const link of ["/t/t-flaky", "/settings/general"]) {
  test(`a launch on ${link} stays there, though a workspace exists`, async ({ page }) => {
    await seed(page, {
      "gram.mock.settings": WELCOME_UNSEEN,
      "gram.mock.orchestration": "board",
    });
    await page.goto(link);
    // The workspace is listed, so a landing on its orchestrator could have happened. Settings has
    // no overview to show it in, so there the app's own list is asked.
    if (link.startsWith("/settings")) {
      await expect(page.getByTestId("settings-title")).toBeVisible();
      await expect
        .poll(() => page.evaluate(async () => (await window.gramMock!.listWorkspaces()).length))
        .toBeGreaterThan(0);
    } else {
      await expect(page.getByTestId("overview-workspace").first()).toBeVisible();
    }
    // Long enough for a landing to have happened; it never does off the home page.
    await page.waitForTimeout(1_000);
    await expect(page).toHaveURL(new RegExp(`${link}$`));
  });
}
