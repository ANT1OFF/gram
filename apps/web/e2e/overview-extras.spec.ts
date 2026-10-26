import { expect, test, type Page } from "@playwright/test";

import type { MockOneThreadSimulation } from "../src/api/mock-asks";
import { pressFirstWorkspaceKey } from "./thread-row";

// The overview sidebar's extras: Pull requests and Done
// today, folded until opened, the usage meters and worker slots at its foot, ⌘J's jump into its
// workers, and Settings → General's Sidebar sections. Each is checked against what the right
// panel's PR lists, ⌘J's list, the title bar's meter and the ledger say. Mock state lives in memory, so every
// step after the seed stays inside the app, bar the reload the settings are kept across.

const MOCK_SETTINGS_KEY = "gram.mock.settings";

/**
 * `kept` is what the window keeps of its layout by itself, outside the settings (`gram.layout`), as
 * where each PR list shows.
 */
const start = async (page: Page, kept: Record<string, unknown> = {}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(
    ([key, own]) => {
      if (sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(key, JSON.stringify({ panel: { open: false } }));
        localStorage.setItem("gram.layout", JSON.stringify({ state: own, version: 1 }));
      }
    },
    [MOCK_SETTINGS_KEY, kept] as const,
  );
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const made: MockOneThreadSimulation = await page.evaluate(() =>
    window.gramMock!.simulateOneThread(),
  );
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.getByTestId("feature-card").first()).toBeVisible();
  return made;
};

const overview = (page: Page) => page.getByTestId("overview-sidebar");
const section = (page: Page, id: string) => page.getByTestId(`overview-section-${id}`);
const sectionTitle = (page: Page, id: string) =>
  section(page, id).getByRole("heading").getByRole("button");
const storedLayout = (page: Page) =>
  page.evaluate(
    (key) =>
      (JSON.parse(sessionStorage.getItem(key) ?? "{}").layout ?? {}) as Record<string, unknown>,
    MOCK_SETTINGS_KEY,
  );

/** Each row's kind, `owner/repo#n` and title, as the overview lists them. */
const overviewPrs = (page: Page) =>
  section(page, "pullRequests")
    .getByTestId("overview-pr")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        kind: row.getAttribute("data-kind"),
        pr: row.getAttribute("data-pr"),
        title: row.querySelector('[data-testid="overview-pr-title"]')?.textContent,
      })),
    );

/** The same of the right panel's Review requests and Open PRs, from each row's name. */
const panelPrs = async (page: Page) => {
  const read = (testId: string, kind: string) =>
    page
      .getByTestId("right-panel")
      .getByTestId(testId)
      .getByRole("button", { name: /^Open .+#\d+ on GitHub: / })
      .evaluateAll(
        (buttons, k) =>
          buttons.map((button) => {
            const [, pr, title] = /^Open (.+#\d+) on GitHub: (.*)$/.exec(
              button.getAttribute("aria-label") ?? "",
            )!;
            return { kind: k, pr, title };
          }),
        kind,
      );
  return [...(await read("review-requests", "review")), ...(await read("open-prs", "yours"))];
};

const byPr = (a: { pr: string | null | undefined }, b: { pr: string | null | undefined }) =>
  (a.pr ?? "").localeCompare(b.pr ?? "");

/** Both PR lists placed in the right panel as well, where they can be read beside the overview. */
const IN_PANEL = { reviewRequestsPlacement: "panel", openPrsPlacement: "panel" } as const;

/** Shows the right panel on its Reviews tab, where the lists placed there are. */
const toPanel = async (page: Page) => {
  await page.keyboard.press("ControlOrMeta+Alt+b");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: /Reviews/ }).click();
  await expect(panel.getByRole("tab", { name: /Reviews/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  return panel;
};

test("Pull requests starts folded and lists the PR lists' PRs, opening one on GitHub", async ({
  page,
}) => {
  await start(page, IN_PANEL);
  const title = sectionTitle(page, "pullRequests");
  await expect(title).toHaveAttribute("aria-expanded", "false");
  const rows = section(page, "pullRequests").getByTestId("overview-pr");
  await expect(rows.first()).toBeHidden();

  await title.click();
  await expect(title).toHaveAttribute("aria-expanded", "true");
  await expect(rows.first()).toBeVisible();
  const listed = await overviewPrs(page);
  expect(listed.length).toBeGreaterThan(1);
  await expect(title).toContainText(String(listed.length));
  // The review requests first, then your own; each says which, and `repo#n · author` under it.
  expect(listed.map((row) => row.kind)).toEqual(
    listed.map((row) => row.kind).toSorted((a, b) => (a === b ? 0 : a === "review" ? -1 : 1)),
  );
  const first = rows.first();
  await expect(first).toContainText(listed[0]!.kind!);
  await expect(first.getByTestId("overview-pr-sub")).toHaveText(/^[\w.-]+#\d+( · .+)?$/);

  // A click opens it on GitHub, as the lists' rows do.
  const url = await page.evaluate(async (pr) => {
    const { requests } = await window.gramMock!.listReviewRequests();
    const { prs } = await window.gramMock!.listOpenPrs();
    return [...requests, ...prs].find((each) => `${each.repo}#${each.number}` === pr)?.url;
  }, listed[0]!.pr);
  expect(url).toBeDefined();
  await first.click();
  await expect.poll(() => page.evaluate(() => window.gramMock?.opened)).toContain(url);

  // The same PRs as the lists in the right panel, in the same window.
  const panel = await toPanel(page);
  await expect(panel.getByTestId("review-requests")).toBeVisible();
  await expect(panel.getByTestId("open-prs")).toBeVisible();
  const inPanel = await panelPrs(page);
  expect(inPanel.toSorted(byPr)).toEqual(listed.toSorted(byPr));
});

test("Pull requests stays folded until opened, kept across a reload, and leaves out a list placed nowhere", async ({
  page,
}) => {
  await start(page, IN_PANEL);
  const title = sectionTitle(page, "pullRequests");
  await title.click();
  await expect(title).toHaveAttribute("aria-expanded", "true");
  await page.reload();
  await expect(sectionTitle(page, "pullRequests")).toHaveAttribute("aria-expanded", "true");
  const kinds = section(page, "pullRequests").getByTestId("overview-pr");
  await expect(kinds.and(page.locator('[data-kind="review"]')).first()).toBeVisible();
  await expect(kinds.and(page.locator('[data-kind="yours"]')).first()).toBeVisible();

  // Review requests placed nowhere, from the list's own menu in the right panel (a right-click on
  // its first repository's heading): gone here too.
  const panel = await toPanel(page);
  await panel
    .getByTestId("review-requests")
    .getByRole("heading")
    .first()
    .click({ button: "right" });
  const menu = page.getByTestId("review-requests-menu");
  await menu.getByRole("menuitem", { name: "Show in" }).hover();
  await page.getByRole("menuitemradio", { name: "Hidden" }).click();
  await expect(page.getByTestId("review-requests")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(overview(page)).toBeVisible();
  await expect(kinds.and(page.locator('[data-kind="review"]'))).toHaveCount(0);
  await expect(kinds.and(page.locator('[data-kind="yours"]')).first()).toBeVisible();
});

test("Done today starts folded and has ⌘J's Done today rows, opening one as ⌘J does", async ({
  page,
}) => {
  const made = await start(page);
  const title = sectionTitle(page, "doneToday");
  await expect(title).toHaveAttribute("aria-expanded", "false");
  await title.click();
  const rows = section(page, "doneToday").getByTestId("overview-done");
  await expect(rows.first()).toBeVisible();

  // ⌘J's own list, with the overview hidden so ⌘J opens it.
  await page.keyboard.press("ControlOrMeta+KeyB");
  await expect(overview(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+KeyJ");
  const list = page.getByTestId("workers-list");
  await expect(list).toBeVisible();
  const fromList = await list
    .getByTestId("workers-section-doneToday")
    .getByTestId("worker-row")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-thread-id")));
  expect(fromList).toContain(made.doneToday);
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await page.keyboard.press("ControlOrMeta+KeyB");
  await expect(overview(page)).toBeVisible();

  const here = rows.and(page.locator(`[data-workspace-id="${made.workspaceId}"]`));
  await expect(here).toHaveCount(fromList.length);
  const fromOverview = await here.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-thread-id")),
  );
  expect(fromOverview.toSorted()).toEqual(fromList.toSorted());

  const merged = rows.and(page.locator(`[data-thread-id="${made.doneToday}"]`));
  await expect(merged).toHaveAttribute("data-merged", "true");
  await expect(merged.getByTestId("overview-done-time")).toHaveText(/^\d{2}:\d{2}$/);
  await expect(merged.getByTestId("overview-done-sub")).toHaveText(
    /^agent-platform · merged api#\d+$/,
  );
  await merged.click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.doneToday}$`));
});

test("the foot's usage matches the title bar meter's, and its slots the cap and held briefs", async ({
  page,
}) => {
  const made = await start(page);
  const foot = overview(page).getByTestId("overview-foot");
  await expect(foot).toBeVisible();

  // The title bar's popover, each provider's 5-hour row.
  await page.getByTestId("usage-meter").click();
  const popover = page.getByRole("dialog", { name: "Subscription usage" });
  const fiveHour = async (provider: string) => {
    const cells = popover
      .getByRole("region", { name: provider })
      .locator('[data-testid="usage-limit-row"][data-window="fiveHour"] > span:not([aria-hidden])');
    return { percent: await cells.nth(1).textContent(), resets: await cells.nth(2).textContent() };
  };
  const claude = await fiveHour("Claude Code");
  const codex = await fiveHour("Codex");
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  const meters = foot.getByTestId("overview-usage");
  await expect(meters).toHaveCount(2);
  await expect(meters.nth(0)).toHaveAttribute("data-provider", "claude");
  await expect(meters.nth(0).getByTestId("overview-usage-text")).toHaveText(
    `${claude.percent} · ${claude.resets}`,
  );
  await expect(meters.nth(0)).not.toHaveAttribute("data-warn");
  await expect(meters.nth(1)).toHaveAttribute("data-provider", "codex");
  await expect(meters.nth(1).getByTestId("overview-usage-text")).toHaveText(
    `${codex.percent} · ${codex.resets}`,
  );
  // Codex is past the warning, as the title bar's meter says.
  await expect(meters.nth(1)).toHaveAttribute("data-warn", "true");
  await expect(page.getByTestId("usage-meter")).toHaveAttribute("data-warn", "true");

  // Slots: the workspace's live workers against its cap, and its held briefs.
  await page.evaluate(
    (id) =>
      window.gramMock!.simulateHeldBrief(id as never, {
        feature: "nightly-report",
        title: "Nightly report",
        agent: "codex",
        usedPct: 85,
        until: Date.now() + 60 * 60_000,
      }),
    made.workspaceId,
  );
  const ledger = () =>
    page.evaluate(async (id) => {
      const { budget, held } = await window.gramMock!.orchestratorLedger(id as never);
      return {
        live: budget.liveWorkers,
        cap: budget.maxConcurrentWorkers,
        held: held?.length ?? 0,
      };
    }, made.workspaceId);
  const slots = foot.getByTestId("overview-slots");
  await expect.poll(async () => (await ledger()).held).toBe(1);
  const want = await ledger();
  await expect(slots).toHaveAttribute("data-held", "1");
  await expect(slots).toHaveAttribute("data-live", String(want.live));
  await expect(slots).toHaveAttribute("data-cap", String(want.cap));
  await expect(slots.getByTestId("overview-slots-text")).toHaveText(
    `${want.live} of ${want.cap} · 1 held`,
  );
  await expect(slots).toContainText("Worker slots");
  await expect(slots.locator("i[data-taken]")).toHaveCount(Math.min(want.live, want.cap));
});

test("⌘J moves to the overview's first worker when it is open, and opens the list when hidden", async ({
  page,
}) => {
  await start(page);
  const list = page.getByTestId("workers-list");
  const first = overview(page).getByTestId("overview-worker").first();
  await expect(first).toBeVisible();

  await page.getByLabel("Message", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await expect(first).toBeFocused();
  await expect(list).toBeHidden();
  // The arrows go on from there, as the overview's own keys.
  await page.keyboard.press("ArrowDown");
  await expect(first).not.toBeFocused();

  // With the Orchestrators section folded, ⌘J opens it first.
  const orchestrators = sectionTitle(page, "orchestrators");
  await orchestrators.click();
  await expect(orchestrators).toHaveAttribute("aria-expanded", "false");
  await page.getByLabel("Message", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await expect(orchestrators).toHaveAttribute("aria-expanded", "true");
  await expect(first).toBeFocused();

  // Hidden, ⌘J opens the Workers list as before, and closes it again.
  await page.keyboard.press("ControlOrMeta+KeyB");
  await expect(overview(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await expect(list).toBeVisible();
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await expect(list).toBeHidden();
});

test("Settings' Sidebar sections hides and shows each section, kept across a reload", async ({
  page,
}) => {
  await start(page);
  const shown = {
    solo: section(page, "solo"),
    pullRequests: section(page, "pullRequests"),
    doneToday: section(page, "doneToday"),
    usage: overview(page).getByTestId("overview-foot"),
  } as const;
  for (const where of Object.values(shown)) await expect(where).toBeVisible();

  // Settings sits beside the overview, so each box's effect shows at once.
  await page.getByLabel("Message", { exact: true }).click();
  await page.keyboard.press("ControlOrMeta+Comma");
  const group = page.getByRole("group", { name: "Sidebar sections" });
  await expect(group).toBeVisible();
  const box = (name: string) => group.getByRole("checkbox", { name });
  const labels = {
    solo: "Solo threads",
    pullRequests: "Pull requests",
    doneToday: "Done today",
    usage: "Usage and slots",
  } as const;
  await expect(group.getByRole("checkbox")).toHaveCount(4);
  for (const label of Object.values(labels)) await expect(box(label)).toBeChecked();

  // One at a time: each off leaves the ones still on, and only what is off is stored.
  const off: Record<string, false> = {};
  for (const [key, label] of Object.entries(labels) as [keyof typeof labels, string][]) {
    await box(label).uncheck();
    off[key] = false;
    await expect(shown[key]).toHaveCount(0);
    for (const [other, where] of Object.entries(shown)) {
      if (!(other in off)) await expect(where).toBeVisible();
    }
    await expect.poll(async () => (await storedLayout(page))["overviewSections"]).toEqual(off);
  }
  await expect(section(page, "orchestrators")).toBeVisible();

  // Kept across a reload.
  await page.reload();
  await expect(section(page, "orchestrators")).toBeVisible();
  for (const label of Object.values(labels)) await expect(box(label)).not.toBeChecked();
  for (const where of Object.values(shown)) await expect(where).toHaveCount(0);

  // Back on, one by one, each showing again; with every one on, nothing is stored.
  for (const [key, label] of Object.entries(labels) as [keyof typeof labels, string][]) {
    await box(label).check();
    delete off[key];
    await expect(shown[key]).toBeVisible();
    await expect
      .poll(async () => (await storedLayout(page))["overviewSections"])
      .toEqual(Object.keys(off).length === 0 ? undefined : off);
  }
  await page.reload();
  for (const label of Object.values(labels)) await expect(box(label)).toBeChecked();
  for (const where of Object.values(shown)) await expect(where).toBeVisible();
});
