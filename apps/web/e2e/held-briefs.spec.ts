import { expect, test, type Page } from "@playwright/test";

import { openOrchestrator, pressFirstWorkspaceKey } from "./thread-row";

// Low-priority briefs held until a usage limit resets: the
// held state on the Board and on the feature card in the stream, with its reset on a 24-hour
// clock, Release now, and the release at the reset. Mock state lives in memory, so every step
// after the seed navigates inside the app; nothing reloads.

const seed = async (page: Page) => {
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
};

const openBoard = async (page: Page) => {
  await seed(page);
  const made = await page.evaluate(() => window.gramMock!.simulateAsks());
  await openOrchestrator(page, made.orchestratorThreadId);
  await page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  await expect(page.getByTestId("rail-board")).toBeVisible();
  return made;
};

/**
 * Holds a brief for `feature` until `inMs` from now, and gives back what the page's 24-hour clock
 * reads for that time.
 */
const hold = (page: Page, workspaceId: string, feature: string, title: string, inMs: number) =>
  page.evaluate(
    ([id, slug, name, after]) => {
      const until = Date.now() + after;
      const brief = window.gramMock!.simulateHeldBrief(id as never, {
        feature: slug,
        title: name,
        agent: "codex",
        usedPct: 85,
        until,
      });
      const clock = new Date(until).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      return { id: brief.id, clock };
    },
    [workspaceId, feature, title, inMs] as const,
  );

const line = (page: Page, feature: string) =>
  page.getByTestId("rail-board").locator(`[data-testid="rail-row"][data-feature="${feature}"]`);

test("a held brief sits on the Board's Briefed station with its reset, and Release now starts it", async ({
  page,
}) => {
  const made = await openBoard(page);
  const { id, clock } = await hold(
    page,
    made.workspaceId,
    "nightly-docs",
    "Nightly docs",
    3 * 3_600_000,
  );

  const row = line(page, "nightly-docs");
  const chip = row.getByTestId("rail-held");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("data-held-id", id);
  await expect(chip).toContainText("Nightly docs");
  // 24-hour, with the weekday only when the reset falls on another day.
  await expect(chip.getByTestId("held-until")).toHaveText(new RegExp(`^until (\\w{3} )?${clock}$`));
  await expect(chip.getByTestId("held-until")).not.toHaveText(/AM|PM/);
  await expect(chip).toHaveAttribute("title", /^Codex is at 85% of its 5-hour limit/);
  // It is on Briefed, and no worker exists for it yet.
  await expect(row.getByRole("list", { name: "Briefed" }).getByTestId("rail-held")).toHaveCount(1);
  await expect(row.getByTestId("rail-worker")).toHaveCount(0);

  await chip.getByRole("button", { name: "Release Nightly docs now" }).click();
  await expect(row.getByTestId("rail-held")).toHaveCount(0);
  await expect(row.getByTestId("rail-worker")).toHaveCount(1);
  await expect(row.getByTestId("rail-worker")).toHaveAttribute("data-station", "briefed");
  const ledger = await page.evaluate(
    (workspaceId) => window.gramMock!.orchestratorLedger(workspaceId as never),
    made.workspaceId,
  );
  expect(ledger.held).toBeUndefined();
});

test("the feature card in the stream shows the brief held, and it starts on its own at the reset", async ({
  page,
}) => {
  await seed(page);
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.getByTestId("feature-card").first()).toBeVisible();

  // Held on a feature that already has workers: its card gains the held line.
  const card = page.locator('[data-testid="feature-card"][data-feature="mail-trigger"]');
  await expect(card).toBeVisible();
  const workers = await card.getByTestId("feature-card-worker").count();
  const { clock } = await hold(page, made.workspaceId, "mail-trigger", "Mail docs", 4_000);
  const held = card.getByTestId("held-brief");
  await expect(held).toBeVisible();
  await expect(held).toContainText("Mail docs");
  await expect(held.getByTestId("held-until")).toHaveText(
    new RegExp(`^Held until (\\w{3} )?${clock}$`),
  );
  await expect(held.getByRole("button", { name: "Release Mail docs now" })).toBeVisible();

  // At the reset it is spawned without a click: the held line gives way to a worker.
  await expect(held).toHaveCount(0, { timeout: 15_000 });
  await expect(card.getByTestId("feature-card-worker")).toHaveCount(workers + 1);
  await expect(card.getByTestId("feature-card-worker").last()).toContainText("Mail docs");
});

test("a provider recovery hold uses the existing held chip and exposes its failure reason", async ({
  page,
}, testInfo) => {
  const made = await openBoard(page);
  await hold(page, made.workspaceId, "provider-recovery", "Provider recovery", 600_000);
  const chip = line(page, "provider-recovery").getByTestId("rail-held");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("title", /^Codex is at 85%/);
  await chip.scrollIntoViewIfNeeded();
  await chip.screenshot({ path: testInfo.outputPath("spawn-circuit-breaker-before.png") });
  const before = await chip.getAttribute("data-held-id");
  await page.evaluate(
    async ([workspaceId, id]) => {
      await window.gramMock!.releaseHeldBrief(workspaceId as never, id!);
      window.gramMock!.simulateHeldBrief(workspaceId as never, {
        feature: "provider-recovery",
        title: "Provider recovery",
        agent: "codex",
        usedPct: 0,
        until: Date.now() + 600_000,
        reason:
          "Held: codex:gpt-synthetic failed with network without output at 2026-10-23T18:00:00.000Z. One held worker probes after ten minutes; output clears this hold.",
      });
    },
    [made.workspaceId, before] as const,
  );
  await expect(chip).toHaveAttribute(
    "title",
    /^Held: codex:gpt-synthetic failed with network without output at/,
  );
  await expect(chip.getByRole("button", { name: "Release Provider recovery now" })).toBeEnabled();
  await expect(chip).not.toHaveAttribute("title", /0%|5-hour limit/);
  await chip.scrollIntoViewIfNeeded();
  await chip.screenshot({ path: testInfo.outputPath("spawn-circuit-breaker-after.png") });
});
