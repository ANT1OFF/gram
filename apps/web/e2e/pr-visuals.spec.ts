import { expect, test, type Page } from "@playwright/test";

import type { MockOneThreadSimulation } from "../src/api/mock-asks";
import { pressFirstWorkspaceKey } from "./thread-row";

// The shared pull request vocabulary where the Orchestrator layout shows PRs: a worker's chips under
// its overview row, their hover card and the feature card. Three workers hold PRs in different
// states: failing CI its worker is fixing, with a merge armed; approved but held; and conflicting
// while waiting on another PR. Set `GRAM_PR_VISUALS_SHOTS` to a folder to keep the screenshots.

const SHOTS = process.env["GRAM_PR_VISUALS_SHOTS"];

const THEMES = {
  dark: { palette: "neutral-dark", mode: "dark" },
  light: { palette: "tokyo-light", mode: "light" },
} as const;

const start = async (page: Page, mode: keyof typeof THEMES): Promise<MockOneThreadSimulation> => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ palette, mode: picked }) => {
    if (localStorage.getItem("gram.theme") === null) {
      localStorage.setItem(
        "gram.theme",
        JSON.stringify({
          state: {
            look: "glass",
            palette,
            mode: picked,
            density: "compact",
            contrast: "system",
            motion: "off",
            customPalettes: [],
          },
          version: 1,
        }),
      );
    }
    if (sessionStorage.getItem("gram.mock.settings") === null) {
      sessionStorage.setItem(
        "gram.mock.settings",
        JSON.stringify({
          panel: { open: false },
          appearance: {
            look: "glass",
            paletteId: palette,
            mode: picked,
            density: "compact",
            contrast: "standard",
            motion: "off",
          },
        }),
      );
    }
  }, THEMES[mode]);
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.getByTestId("feature-card").first()).toBeVisible();
  return made;
};

/** Gives the live, asking and held workers a PR each, and the live one a draft it follows. */
const seedPrs = (page: Page, made: MockOneThreadSimulation) =>
  page.evaluate(
    ({ live, asking, held }) => {
      const mock = window.gramMock!;
      const quiet = { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 };
      const review = { bots: ["claude"], reviewedHead: true, roundInFlight: false, threads: quiet };
      const git = {
        repo: true,
        worktree: true,
        head: "abc",
        changesToken: "tok",
        changedFiles: 0,
        base: "origin/main",
        behindBase: 0,
        aheadBase: 2,
        conflicts: false,
        upstream: "synced",
        origin: "acme/api",
      };
      const pr = (number: number, more: Record<string, unknown>) => ({
        number,
        state: "OPEN",
        url: `https://github.com/acme/api/pull/${number}`,
        title: `PR ${number}`,
        isDraft: false,
        checks: "passing",
        headMatches: true,
        aheadOfPr: false,
        additions: 120,
        deletions: 14,
        changedFiles: 6,
        baseRef: "main",
        review,
        ...more,
      });
      const at = Date.now();
      // Failing CI on a running worker that will fix it, its merge armed.
      mock.world.updateThread(
        live as never,
        {
          boundPr: {
            repo: "acme/api",
            number: 214,
            monitor: true,
            mergeWhenReady: { method: "squash", allowedBy: "user", setAt: at },
          },
          extraPrs: [{ repo: "acme/web", number: 48, monitor: false }],
        } as never,
      );
      mock.world.publishGit(
        live as never,
        {
          ...git,
          branch: "feat/queue-retry",
          pr: pr(214, {
            title: "Retry the queue with backoff",
            checks: "failing",
            headRef: "feat/queue-retry",
            mergeState: "BLOCKED",
          }),
          extraPrs: [
            pr(48, {
              url: "https://github.com/acme/web/pull/48",
              title: "Trigger form calls the endpoint",
              isDraft: true,
              checks: "pending",
              review: { ...review, roundInFlight: true },
            }),
          ],
        } as never,
      );
      // Green and approved, but its merge held until the release ships.
      mock.world.updateThread(
        asking as never,
        {
          boundPr: {
            repo: "acme/api",
            number: 215,
            monitor: true,
            mergeWhenReady: {
              method: "squash",
              allowedBy: "user",
              setAt: at,
              hold: "after the 0.2.0 release",
              heldBy: "orchestrator",
            },
          },
        } as never,
      );
      mock.world.publishGit(
        asking as never,
        {
          ...git,
          branch: "feat/mail-trigger",
          pr: pr(215, {
            title: "Mail trigger",
            headRef: "feat/mail-trigger",
            reviewDecision: "APPROVED",
            mergeState: "CLEAN",
            review: { ...review, verdictOnHead: "approved", verdictOnHeadBy: "claude" },
          }),
        } as never,
      );
      // Conflicting with main while it waits on #214 to merge.
      mock.world.updateThread(
        held as never,
        {
          boundPr: {
            repo: "acme/api",
            number: 216,
            monitor: true,
            mergeWhenReady: { method: "squash", allowedBy: "user", setAt: at },
            dependsOn: [{ repo: "acme/api", number: 214, setBy: "orchestrator", setAt: at }],
          },
        } as never,
      );
      mock.world.publishGit(
        held as never,
        {
          ...git,
          branch: "feat/dead-letter",
          pr: pr(216, {
            title: "Dead-letter queue",
            headRef: "feat/dead-letter",
            checks: "passing",
            mergeState: "DIRTY",
            reviewDecision: "REVIEW_REQUIRED",
          }),
        } as never,
      );
    },
    { live: made.live, asking: made.asking, held: made.held },
  );

const shot = async (name: string, target: ReturnType<Page["locator"]>) => {
  if (SHOTS === undefined) return;
  await target.screenshot({ path: `${SHOTS}/${name}.png`, animations: "disabled" });
};

for (const mode of ["dark", "light"] as const) {
  test(`PRs read at a glance in the overview and on the feature card, ${mode}`, async ({
    page,
  }) => {
    const made = await start(page, mode);
    await seedPrs(page, made);
    const overview = page.getByTestId("overview-sidebar");
    const chips = overview.locator(
      `[data-testid="overview-pr-chips"][data-thread-id="${made.live}"] [data-testid="overview-pr-chip"]`,
    );
    await expect(chips).toHaveCount(2);
    const chipOf = (threadId: string) =>
      overview.locator(
        `[data-testid="overview-pr-chips"][data-thread-id="${threadId}"] [data-testid="overview-pr-chip"]`,
      );
    // Each chip leads with its state's glyph; the live worker's failing CI is its own to fix and
    // its merge is armed; the held worker conflicts and waits on #214; the asking one is held.
    await expect(chips.nth(0).locator('[data-pr-mark="state"]')).toHaveAttribute(
      "data-kind",
      "open",
    );
    await expect(chips.nth(1).locator('[data-pr-mark="state"]')).toHaveAttribute(
      "data-kind",
      "draft",
    );
    await expect(chips.nth(0).locator("[data-checks]")).toHaveAttribute("data-checks", "fixing");
    await expect(chips.nth(0)).toHaveAttribute("data-merge", "armed");
    await expect(chips.nth(0)).toHaveAttribute("data-tone", "plain");
    await expect(chipOf(made.asking)).toHaveAttribute("data-merge", "held");
    await expect(chipOf(made.asking)).toHaveAccessibleName(
      /merge held by the orchestrator: after the 0\.2\.0 release/,
    );
    await expect(chipOf(made.asking).locator('[data-pr-mark="review"]')).toHaveAttribute(
      "data-kind",
      "approved",
    );
    await expect(chipOf(made.held)).toHaveAttribute("data-merge", "conflicts");
    await expect(chipOf(made.held)).toHaveAccessibleName(/merges after acme\/api#214/);
    await page.waitForTimeout(300);
    await shot(`${mode}-overview`, overview);
    await chips.nth(0).hover();
    const card = page.getByTestId("overview-pr-card");
    await expect(card).toContainText("Retry the queue with backoff");
    await expect(card).toContainText("acme/api#214");
    await expect(card.getByTestId("pr-mark-lines")).toContainText("its worker is fixing them");
    await expect(card.getByTestId("pr-mark-lines")).toContainText("Merges when ready");
    await expect(card.getByTestId("pr-diff-stat")).toHaveText("+120−146 files");
    await page.waitForTimeout(300);
    await shot(`${mode}-overview-card`, card);
    await page.mouse.move(800, 10);
    await shot(`${mode}-feature-card`, page.getByTestId("feature-card").first());
  });
}
