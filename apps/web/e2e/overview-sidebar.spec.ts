import { expect, test, type Page } from "@playwright/test";

import type { MockOneThreadSimulation } from "../src/api/mock-asks";
import { setLayout } from "./layout";
import { openMore } from "./more-menu";
import { pressFirstWorkspaceKey, threadRow } from "./thread-row";
import { flakyAsked, flakyAsks, parkSeedAsks } from "./seed-asks";

// The overview sidebar, the Orchestrator layout's left
// column: what needs you, one line per workspace with the current one opened into its cards' live
// workers, and the solo threads. A worker's click opens it and never holds, ⌥-click peeks, an "asks
// you" opens on its ask, and ⌘B or the title bar's button hides and shows it, kept in the settings. Mock state lives in memory, so every step after the
// seed stays inside the app, bar the reloads the settings are kept across.

const MOCK_SETTINGS_KEY = "gram.mock.settings";

const start = async (
  page: Page,
  {
    width = 1440,
    panel = false,
    layout = {},
    motion,
  }: {
    width?: number;
    panel?: boolean;
    /** More of `Settings.layout` as stored before the launch. */
    layout?: Record<string, unknown>;
    /** The Motion setting, as Settings → Appearance keeps it. */
    motion?: "off" | "reduced";
  } = {},
): Promise<MockOneThreadSimulation> => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(
    ([key, open, more, appearance]) => {
      if (sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(
          key,
          JSON.stringify({
            layout: more,
            panel: { open },
            ...(appearance === undefined ? {} : { appearance: { motion: appearance } }),
          }),
        );
      }
    },
    [MOCK_SETTINGS_KEY, panel, layout, motion] as const,
  );
  return seed(page);
};

const seed = async (page: Page): Promise<MockOneThreadSimulation> => {
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.getByTestId("feature-card").first()).toBeVisible();
  return made;
};

const overview = (page: Page) => page.getByTestId("overview-sidebar");
const rail = (page: Page) => page.getByTestId("overview-rail");
const tile = (page: Page, workspaceId: string) =>
  rail(page).locator(`[data-testid="overview-tile"][data-workspace-id="${workspaceId}"]`);
const soloTile = (page: Page) =>
  rail(page).locator('[data-testid="overview-tile"][data-tile="solo"]');
/** The open flyout: one closing still fades out beside it. */
const flyout = (page: Page) => page.locator(`[data-testid="overview-flyout"][data-open]`);
const worker = (page: Page, threadId: string) =>
  overview(page).locator(`[data-testid="overview-worker"][data-thread-id="${threadId}"]`);
const workspaceRow = (page: Page, workspaceId: string) =>
  overview(page).locator(`[data-testid="overview-workspace"][data-workspace-id="${workspaceId}"]`);
/** The solo rows outside the Parked and Done lines, the ones Solo threads counts. */
const unparked = (page: Page) =>
  overview(page).locator(
    '[data-testid="overview-solo"]:not([data-testid="overview-parked"] *, [data-testid="overview-done"] *)',
  );
/** The Parked line's button, which folds and unfolds the parked solo threads. */
const parkedLine = (page: Page) =>
  overview(page)
    .getByTestId("overview-parked")
    .getByRole("button", { name: /^Parked/ });
/** The Done line's button, which folds and unfolds the solo threads marked done. */
const doneLine = (page: Page) =>
  overview(page).getByTestId("overview-done").getByRole("button", { name: /^Done/ });
const storedLayout = (page: Page) =>
  page.evaluate(
    (key) =>
      (JSON.parse(sessionStorage.getItem(key) ?? "{}").layout ?? {}) as Record<string, unknown>,
    MOCK_SETTINGS_KEY,
  );
const storedOverview = async (page: Page) => (await storedLayout(page))["overviewSidebar"];
const composer = (page: Page) => page.getByLabel("Message", { exact: true });

/** The cards' live workers, by feature, as the server gives them, with each card's station. */
const liveFromCards = (page: Page, workspaceId: string) =>
  page.evaluate(async (id) => {
    const { cards } = await window.gramMock!.featureCards(id as never);
    const gone = new Set(["merged", "delivered", "done", "archived"]);
    return cards.flatMap((card) => {
      const workers = card.workers.filter((w) => !gone.has(w.state) && w.station !== "merged");
      return workers.length === 0
        ? []
        : [
            {
              feature: card.feature,
              station: card.station,
              workers: workers.map((w) => ({ id: w.threadId, title: w.title, now: w.now })),
            },
          ];
    });
  }, workspaceId);

/** Whether the orchestrator can't message it, and how many messages it has. */
const workerFacts = (page: Page, made: MockOneThreadSimulation, threadId: string) =>
  page.evaluate(
    async ({ workspaceId, target }) => {
      const mock = window.gramMock!;
      const ledger = await mock.orchestratorLedger(workspaceId);
      const entry = ledger.features
        .flatMap((feature) => feature.workers)
        .find((each) => each.threadId === target);
      return { held: entry?.userIntervened, messages: mock.world.messages(target as never).length };
    },
    { workspaceId: made.workspaceId, target: threadId },
  );

test("lists the workspaces in the switcher's order, the current one opened into its cards' live workers", async ({
  page,
}) => {
  const made = await start(page);
  await expect(overview(page)).toBeVisible();
  await expect(overview(page)).toHaveAccessibleName("Overview");

  // The same workspaces, in the same order, as the title bar's switcher.
  await page.getByTestId("workspace-switcher-button").click();
  const names = await page
    .getByTestId("workspace-switcher")
    .locator("[data-switcher-item]")
    .filter({ has: page.locator("kbd") })
    .locator("span.truncate")
    .allTextContents();
  await page.keyboard.press("Escape");
  const rows = overview(page).getByTestId("overview-workspace");
  await expect(rows).toHaveCount(names.length);
  expect(names.length).toBeGreaterThan(1);
  for (const [index, name] of names.entries()) {
    await expect(rows.nth(index).locator("button").first()).toContainText(name);
  }

  // The current one is marked; every one opens into its cards' live workers, its line the same
  // form: the other's count of one worker, and its ask.
  const here = workspaceRow(page, made.workspaceId);
  await expect(here.locator("button[aria-current]").first()).toBeVisible();
  const other = workspaceRow(page, made.asks.other.workspaceId);
  await expect(other.locator("button[aria-current]")).toHaveCount(0);
  await expect(other.getByTestId("overview-workspace-asks")).toHaveText("1");
  await expect(other.getByTestId("overview-workspace-row")).toHaveAttribute("data-live", "1");
  await expect(other.getByTestId("overview-feature")).toHaveAttribute(
    "data-feature",
    "invoice-export",
  );
  await expect(other.getByTestId("overview-worker")).toHaveAttribute(
    "data-thread-id",
    made.asks.other.asking,
  );

  // Its workers are the cards' live workers, feature by feature, with the cards' now lines.
  const live = await liveFromCards(page, made.workspaceId);
  expect(live.length).toBeGreaterThan(1);
  const features = here.locator('[data-testid="overview-feature"]', {
    has: page.getByTestId("overview-worker"),
  });
  await expect(features).toHaveCount(live.length);
  for (const [index, feature] of live.entries()) {
    await expect(features.nth(index)).toHaveAttribute("data-feature", feature.feature);
    // No progress bar on the row: the stage is on its hover and in its name.
    await expect(features.nth(index)).toHaveAttribute("data-station", feature.station);
    await expect(features.nth(index).getByRole("heading")).toHaveAttribute("title", /^Stage: /);
    await expect(features.nth(index).getByTestId("overview-stage")).toHaveCount(0);
    const workers = features.nth(index).getByTestId("overview-worker");
    await expect(workers).toHaveCount(feature.workers.length);
    for (const [at, each] of feature.workers.entries()) {
      await expect(workers.nth(at)).toHaveAttribute("data-thread-id", each.id);
      await expect(workers.nth(at).getByTestId("overview-worker-title")).toHaveText(each.title);
      const asking = (await workers.nth(at).getAttribute("data-asking")) === "true";
      // The now line is always in the row's name; on the row only if it says more than the dot.
      const now = asking ? "asks you" : each.now;
      expect(await workers.nth(at).getAttribute("aria-label")).toContain(`, ${now}`);
      const line = workers.nth(at).getByTestId("overview-worker-now");
      if (asking) await expect(line).toHaveText("asks you");
      else if (["working", "briefed", "in review", "idle"].includes(now)) {
        await expect(line).toHaveCount(0);
      }
    }
  }
  // The cards and the overview say the same: one worker's now line on both.
  const queue = live.flatMap((f) => f.workers).find((w) => w.id === made.live)!;
  await expect(
    page
      .getByTestId("feature-card-worker")
      .filter({ has: page.locator(`a[href$="/t/${made.live}"]`) })
      .getByTestId("feature-card-now"),
  ).toHaveText(queue.now);

  // The in-pane rail and its header controls are gone: the workers show once.
  await expect(page.getByTestId("worker-rail")).toHaveCount(0);
  await expect(page.getByTestId("pane-header").getByTestId("worker-rail-hide")).toHaveCount(0);

  // A click on the other workspace switches to it, as ⌘2 does, and opens it in turn.
  await other.locator("button").first().click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.asks.other.orchestratorThreadId}$`));
  await expect(other.locator("button[aria-current]")).toHaveCount(1);
  await expect(here.locator("button[aria-current]")).toHaveCount(0);
  await expect(here.getByTestId("overview-worker").first()).toBeVisible();
  await expect(page.getByTestId("workspace-switcher-button")).toHaveAccessibleName(
    new RegExp(names[1]!),
  );
});

test("a worker's agent shows only when it isn't its orchestrator's, and always in its name and card", async ({
  page,
}) => {
  const made = await start(page);
  const glyph = worker(page, made.inReview).locator("svg");
  await expect(worker(page, made.inReview)).toHaveAttribute("aria-label", /, Claude Code, /);
  await expect(glyph).toHaveCount(0);
  await worker(page, made.inReview).hover();
  await expect(page.getByTestId("overview-worker-card-feature")).toContainText("Claude Code");
  await page.mouse.move(1200, 400);

  await page.evaluate((id) => {
    const mock = window.gramMock!;
    const { thread } = mock.world.summary(id as never);
    mock.world.replaceThread({ ...thread, model: { agent: "codex", model: "gpt-5-codex" } });
  }, made.inReview);
  await expect(glyph).toHaveCount(1);
  await expect(worker(page, made.inReview)).toHaveAttribute("aria-label", /, Codex, /);
});

test("an idle row fades after a day and comes back on hover; one needing you never does", async ({
  page,
}) => {
  await start(page);
  // Threads no mock script plays: a script moves its thread's status under the test.
  const row = threadRow(page, "t-release");
  const waiting = threadRow(page, "t-question");
  await expect(waiting).toHaveAccessibleName(/, Needs input$/);
  await page.evaluate(() => {
    const mock = window.gramMock!;
    for (const id of ["t-release", "t-question"]) {
      const { thread } = mock.world.summary(id as never);
      mock.world.replaceThread({ ...thread, lastActivityAt: Date.now() - 25 * 60 * 60_000 });
    }
  });
  await expect(row).toHaveAttribute("data-settled", "true");
  // As old, but it waits on the user, so it stays as it is.
  await expect(waiting).not.toHaveAttribute("data-settled");
  await page.mouse.move(1200, 400);
  await expect(row).toHaveCSS("filter", /grayscale\(1\)/);
  await row.hover();
  await expect(row).not.toHaveCSS("filter", /grayscale\(1\)/);
});

test("a worker's hover card reads it: title, station, now line, PR and a 24-hour time", async ({
  page,
}) => {
  const made = await start(page);
  const live = await liveFromCards(page, made.workspaceId);
  await worker(page, made.inReview).hover();
  const card = page.getByTestId("overview-worker-card");
  await expect(card).toBeVisible();
  const each = live.flatMap((f) => f.workers).find((w) => w.id === made.inReview)!;
  await expect(card.getByTestId("overview-worker-card-title")).toHaveText(each.title);
  await expect(card.getByTestId("overview-worker-card-station")).toHaveText("Review");
  await expect(card.getByTestId("pr-chip")).toHaveCount(1);
  await expect(card.getByTestId("overview-worker-card-time")).toHaveText(/^\d{2}:\d{2}$/);
});

test("a worker closed with its worktree leaves the overview, and so does its feature when it was the last", async ({
  page,
}) => {
  const made = await start(page);
  const live = await liveFromCards(page, made.workspaceId);
  // The feature with the fewest live workers: closing them all takes it out of the ledger, where its
  // card keeps the closed workers as they last were, live-looking.
  const feature = live.reduce((least, each) =>
    each.workers.length < least.workers.length ? each : least,
  );
  const closed = feature.workers.map((each) => each.id);
  for (const threadId of closed) {
    await page.evaluate((id) => window.gramMock!.closeThread(id as never), threadId);
  }
  await expect(overview(page).locator(`[data-feature="${feature.feature}"]`)).toHaveCount(0);
  for (const threadId of closed) await expect(worker(page, threadId)).toHaveCount(0);
  // The other features stay, with their workers.
  for (const other of live.filter((each) => each.feature !== feature.feature)) {
    await expect(overview(page).locator(`[data-feature="${other.feature}"]`)).toBeVisible();
  }
});

/** Each worker dot's animation: its name where it pulses (`gram-working`), else `none`, by its row. */
const dotAnimations = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="overview-worker-dot"]')].map(
      (dot) => ({
        threadId: dot.closest<HTMLElement>('[data-testid="overview-worker"]')?.dataset["threadId"],
        working: dot.hasAttribute("data-working"),
        animation: getComputedStyle(dot).animationName,
        opacity: getComputedStyle(dot).opacity,
      }),
    ),
  );

test("a worker whose turn runs pulses its dot; the other rows stay still", async ({ page }) => {
  const made = await start(page);
  const dots = await dotAnimations(page);
  const live = dots.find((dot) => dot.threadId === made.live)!;
  expect(live.working).toBe(true);
  expect(live.animation).toBe("gram-working");
  // Only the turns that run pulse: the rest of the rows keep their dots still.
  expect(dots.filter((dot) => dot.working).length).toBeGreaterThanOrEqual(1);
  expect(dots.some((dot) => !dot.working)).toBe(true);
  for (const dot of dots) {
    expect(dot.animation).toBe(dot.working ? "gram-working" : "none");
  }
  for (const threadId of [made.asks.choosing, made.inReview]) {
    expect(dots.find((dot) => dot.threadId === threadId)?.animation).toBe("none");
  }
});

test("the system's reduced motion stops the pulse and leaves the dot still", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const made = await start(page);
  const dots = await dotAnimations(page);
  const live = dots.find((dot) => dot.threadId === made.live)!;
  expect(live.working).toBe(true);
  expect(live.animation).toBe("none");
  expect(live.opacity).toBe("1");
});

test("Motion off stops the pulse and leaves the dot still", async ({ page }) => {
  const made = await start(page, { motion: "off" });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
  const dots = await dotAnimations(page);
  const live = dots.find((dot) => dot.threadId === made.live)!;
  expect(live.working).toBe(true);
  expect(live.animation).toBe("none");
  expect(live.opacity).toBe("1");
});

test("a click opens the worker without holding it, ⌥-click peeks and ⌘-click keeps it beside", async ({
  page,
}) => {
  const made = await start(page);
  const before = await workerFacts(page, made, made.live);
  expect(before.held).toBe(false);
  const home = () => workspaceRow(page, made.workspaceId).locator("button").first().click();

  // A plain click lands on its own thread, as opening it anywhere else does; watching holds nothing.
  await worker(page, made.live).click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.live}$`));
  await expect(page.getByTestId("peek-sheet")).toHaveCount(0);
  await expect(composer(page)).toBeVisible();
  expect(await workerFacts(page, made, made.live)).toEqual(before);

  // Enter on a focused row does the same.
  await home();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await worker(page, made.live).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/t/${made.live}$`));
  expect(await workerFacts(page, made, made.live)).toEqual(before);

  // ⌥-click peeks in the sheet, staying where it was.
  await home();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await worker(page, made.live).click({ modifiers: ["Alt"] });
  const sheet = page.getByTestId("peek-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute("data-kind", "worker");
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(worker(page, made.live)).toBeFocused();
  expect(await workerFacts(page, made, made.live)).toEqual(before);

  await worker(page, made.live).click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByTestId("beside-dock")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  expect((await workerFacts(page, made, made.live)).held).toBe(false);
});

test("a worker that asks opens on its ask, and arrows walk the overview", async ({ page }) => {
  const made = await start(page);
  const asking = overview(page).locator('[data-testid="overview-worker"][data-asking="true"]');
  await expect(asking.first()).toBeVisible();
  for (const threadId of [made.asks.choosing, made.asks.pushers[0]]) {
    const target = worker(page, threadId);
    await expect(target).toHaveAttribute("data-asking", "true");
    await expect(target.getByTestId("overview-worker-now")).toHaveText("asks you");
    const before = await workerFacts(page, made, threadId);
    await target.click();
    // Its thread, with what it asks on show there to answer.
    await expect(page).toHaveURL(new RegExp(`/t/${threadId}$`));
    await expect(
      page.locator("main").getByTestId("approval-card").or(page.getByTestId("question-card")),
    ).toBeVisible();
    await expect(page.getByTestId("peek-sheet")).toHaveCount(0);
    expect(await workerFacts(page, made, threadId)).toEqual(before);
  }
  await workspaceRow(page, made.workspaceId).locator("button").first().click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));

  // ↓ and ↑ move between the rows, Home goes to the top; typed keys in the composer stay its own.
  const live = worker(page, made.live);
  await live.focus();
  await page.keyboard.press("ArrowDown");
  await expect(live).not.toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(live).toBeFocused();
  await page.keyboard.press("Home");
  await expect(overview(page).getByTestId("overview-needs-you")).toBeFocused();
  await composer(page).click();
  await page.keyboard.type("ab");
  await page.keyboard.press("ArrowUp");
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveValue("ab");
});

test("arrows and End skip a folded section's rows", async ({ page }) => {
  await start(page);
  const head = (id: string, name: RegExp) =>
    overview(page).getByTestId(`overview-section-${id}`).getByRole("button", { name });
  const orchestrators = head("orchestrators", /Orchestrators/);
  const soloHead = head("solo", /Solo threads/);
  // Pull requests and Done today come after Solo threads, folded by default.
  const prsHead = head("pullRequests", /Pull requests/);
  const doneHead = head("doneToday", /Done today/);
  await expect(doneHead).toHaveAttribute("aria-expanded", "false");
  await orchestrators.click();
  await expect(orchestrators).toHaveAttribute("aria-expanded", "false");
  await overview(page).getByTestId("overview-needs-you").focus();
  await page.keyboard.press("ArrowDown");
  await expect(orchestrators).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(soloHead).toBeFocused();
  await page.keyboard.press("End");
  await expect(doneHead).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(prsHead).toBeFocused();
  // The folded Done and Parked lines are stops of their own, the rows hidden under them are not.
  await page.keyboard.press("ArrowUp");
  await expect(doneLine(page)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(parkedLine(page)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(unparked(page).last()).toBeFocused();
  // Folded, Solo threads' rows are passed over the same way.
  await page.keyboard.press("Home");
  await soloHead.click();
  await page.keyboard.press("End");
  await expect(doneHead).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(soloHead).toBeFocused();
});

test("Needs you counts the asks across every workspace, and lists them by workspace", async ({
  page,
}) => {
  await start(page);
  const needs = overview(page).getByTestId("overview-needs-you");
  // Both workspaces' asks and what the threads outside them ask, t-flaky's approval up once its
  // opening turn raises it, and nothing failing or waiting in a tray.
  await flakyAsked(page);
  await expect(needs).not.toHaveAttribute("data-count", "0");
  const count = Number(await needs.getAttribute("data-count"));
  expect(count).toBeGreaterThan(1);
  await expect(needs).toContainText(`${count} need you`);
  await expect(needs).toHaveAttribute("title", /^Needs you/);
  await needs.click();
  const popover = page.getByTestId("needs-you-popover");
  await expect(popover).toBeVisible();
  await expect(needs).toHaveAttribute("aria-expanded", "true");
  await expect(popover.getByRole("region")).toHaveCount(3);
  await expect(popover.getByRole("region", { name: "Threads" })).toBeVisible();
  await expect(popover.getByTestId("needs-you-item")).toHaveCount(Math.min(count, 6));
  // Esc closes it, and the focus goes back to the pill.
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(needs).toBeFocused();
});

test("Needs you counts what the agents left waiting on you too, and goes to it", async ({
  page,
}) => {
  // No asks: the plain mock.
  await page.addInitScript((key) => {
    if (sessionStorage.getItem(key) === null) {
      sessionStorage.setItem(key, JSON.stringify({ panel: { open: false } }));
    }
  }, MOCK_SETTINGS_KEY);
  await page.goto("/t/t-deps");
  await composer(page).waitFor();
  const needs = overview(page).getByTestId("overview-needs-you");
  await parkSeedAsks(page);
  await expect(needs).toHaveText("Nothing needs you");

  await page.evaluate(() =>
    window.gramMock!.simulateWaitOnUser("t-flaky" as never, {
      kind: "action",
      title: "Set up Developer ID signing credentials",
    }),
  );
  await expect(needs).toHaveAttribute("data-count", "1");
  await expect(needs).toContainText("1 needs you");

  // Its row goes to the thread it lives in, at the message that added it.
  await needs.click();
  const row = page.getByTestId("needs-you-popover").getByTestId("needs-you-item");
  await expect(row).toContainText("Set up Developer ID signing credentials");
  await expect(row).toContainText("Fix flaky");
  await row.getByTestId("needs-you-open").click();
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
  await expect(page.getByTestId("needs-you-popover")).toBeHidden();
  await expect(page.getByTestId("wait-chip")).toBeInViewport();
  const tray = page.getByTestId("waiting-tray");
  await expect(tray.getByTestId("waiting-count")).toContainText("1 waiting on you");

  // Done from the popover, it goes from both; what is left is the approval t-flaky's opening turn
  // raised.
  await needs.click();
  await page.getByTestId("needs-you-popover").getByTestId("needs-you-done").click();
  await expect(tray).toBeHidden();
  await expect(row.and(page.locator('[data-kind="wait"]'))).toHaveCount(0);
  await expect
    .poll(async () => Number(await needs.getAttribute("data-count")) - (await flakyAsks(page)))
    .toBe(0);
});

test("solo threads list what lives outside the workspaces, and open it", async ({ page }) => {
  await start(page);
  const solo = overview(page).getByTestId("overview-section-solo");
  const flaky = solo.locator('[data-testid="overview-solo"][data-thread-id="t-flaky"]');
  await expect(flaky).toContainText("Fix flaky");
  await flaky.click();
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
  await expect(flaky).toHaveAttribute("aria-current", "true");

  // A section folds by its title, and stays folded across a reload.
  const head = solo.getByRole("button", { name: /Solo threads/ });
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(flaky).toBeHidden();
  await page.reload();
  await expect(
    overview(page).getByTestId("overview-section-solo").getByRole("button", { name: /Solo/ }),
  ).toHaveAttribute("aria-expanded", "false");
});

test("a parked solo thread waits behind the folded Parked line, and Park on a row moves one there", async ({
  page,
}) => {
  await start(page);
  const parked = overview(page).getByTestId("overview-parked");
  const parkedRows = parked.getByTestId("overview-solo");
  const isRow = (threadId: string) => page.locator(`[data-thread-id="${threadId}"]`);
  // The mock's parked spike is not among the solo threads: the folded line counts it, its row hidden.
  await expect(unparked(page).and(isRow("t-grpc"))).toHaveCount(0);
  await expect(parkedLine(page)).toHaveAttribute("aria-expanded", "false");
  const before = await parkedRows.count();
  expect(before).toBeGreaterThan(0);
  await expect(parkedLine(page)).toHaveText(new RegExp(`^Parked\\s*${before}$`));
  await expect(threadRow(page, "t-grpc")).toBeHidden();

  // A click opens the line onto its rows, and a row opens its thread.
  await parkedLine(page).click();
  await expect(parkedLine(page)).toHaveAttribute("aria-expanded", "true");
  await expect(parkedRows).toHaveCount(before);
  await expect(threadRow(page, "t-grpc")).toBeVisible();
  await expect(threadRow(page, "t-grpc")).toContainText("Spike: gRPC transport");
  await threadRow(page, "t-grpc").click();
  await expect(page).toHaveURL(/\/t\/t-grpc$/);

  // Park from a solo row's menu moves it under the line, and Unpark brings it back.
  await expect(unparked(page).and(isRow("t-flaky"))).toBeVisible();
  await threadRow(page, "t-flaky").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Park", exact: true }).click();
  await expect(parked.locator('[data-thread-id="t-flaky"]')).toBeVisible();
  await expect(unparked(page).and(isRow("t-flaky"))).toHaveCount(0);
  await expect(parkedLine(page)).toHaveAccessibleName(`Parked, ${before + 1}`);
  await threadRow(page, "t-flaky").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpark", exact: true }).click();
  await expect(unparked(page).and(isRow("t-flaky"))).toBeVisible();
  await expect(parked.locator('[data-thread-id="t-flaky"]')).toHaveCount(0);
  await expect(parkedLine(page)).toHaveAccessibleName(`Parked, ${before}`);
});

test("a solo or worker row's menu opens on a right-click or Shift+F10, held workers adding Hand back", async ({
  page,
}) => {
  const made = await start(page);
  const menu = page.getByRole("menu");
  /** The verbs every thread row's menu has. */
  const verbs = async () => {
    await expect(menu.getByRole("menuitem", { name: /^Rename…/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Park", exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Close thread…/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "More…" })).toBeVisible();
  };
  const handBack = menu.getByRole("menuitem", { name: "Hand back to orchestrator" });

  const solo = threadRow(page, "t-flaky");
  await solo.click({ button: "right" });
  await verbs();
  await expect(handBack).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  // Without a mouse: Shift+F10 on the focused row opens the same menu.
  await solo.focus();
  await page.keyboard.press("Shift+F10");
  await verbs();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // A worker's has the same verbs; Hand back only once the user holds it.
  const live = worker(page, made.live);
  await live.click({ button: "right" });
  await verbs();
  await expect(handBack).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.evaluate((id) => window.gramMock!.takeOverWorker(id as never), made.live);
  await expect.poll(async () => (await workerFacts(page, made, made.live)).held).toBe(true);
  await live.focus();
  await page.keyboard.press("Shift+F10");
  await verbs();
  await handBack.click();
  await expect.poll(async () => (await workerFacts(page, made, made.live)).held).toBe(false);

  // More… opens ⌘K on that one thread's commands, for a solo row and a worker alike.
  const flaky = await openMore(page, solo);
  await expect(flaky.getByTestId("palette-scope")).toContainText("Fix flaky");
  await page.keyboard.press("Escape");
  await expect(flaky).toBeHidden();
  const title = (await live.getByTestId("overview-worker-title").textContent())!;
  const theirs = await openMore(page, live);
  await expect(theirs.getByTestId("palette-scope")).toContainText(title);
});

test("a solo row dragged onto an empty pane of the grid opens its thread there", async ({
  page,
}) => {
  const made = await start(page);
  await setLayout(page, "2 columns");
  const panes = page.getByTestId("pane");
  await expect(panes).toHaveCount(2);
  await expect(panes.nth(0)).toHaveAttribute("data-thread-id", made.orchestratorThreadId);
  await expect(page.getByTestId("empty-pane")).toHaveCount(1);
  await threadRow(page, "t-flaky").dragTo(panes.nth(1));
  await expect(panes.nth(1)).toHaveAttribute("data-thread-id", "t-flaky");
  await expect(page.getByTestId("empty-pane")).toHaveCount(0);
  await expect(panes.nth(0)).toHaveAttribute("data-thread-id", made.orchestratorThreadId);
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
});

test("⌘B hides and shows the overview, kept in the settings across a reload", async ({ page }) => {
  await start(page);
  await expect(overview(page)).toBeVisible();
  // From the composer, while typing: ⌘B is a chord, so the composer keeps what it has.
  await composer(page).click();
  await page.keyboard.type("draft");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(overview(page)).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveValue("draft");
  await expect.poll(() => storedOverview(page)).toBe("hidden");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(overview(page)).toBeVisible();
  await expect.poll(() => storedOverview(page)).toBeUndefined();
  await page.keyboard.press("ControlOrMeta+b");
  await expect.poll(() => storedOverview(page)).toBe("hidden");

  await page.reload();
  await seed(page);
  await expect(overview(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+b");
  await expect(overview(page)).toBeVisible();
  await expect.poll(() => storedOverview(page)).toBeUndefined();

  // Its own button hides it too, and hands the focus to the composer rather than the page.
  await overview(page).getByTestId("overview-hide").click();
  await expect(overview(page)).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
  await expect.poll(() => storedOverview(page)).toBe("hidden");

  // ⌘B with the focus on one of its rows does the same.
  await page.keyboard.press("ControlOrMeta+b");
  await overview(page).getByTestId("overview-needs-you").focus();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(overview(page)).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
});

test("hidden, the title bar's button shows the overview again", async ({ page }) => {
  await start(page);
  const show = page.getByTestId("shell-titlebar").getByTestId("overview-show");
  // Shown, only the overview's own button hides it.
  await expect(show).toHaveCount(0);
  const hide = overview(page).getByTestId("overview-hide");
  const shownAt = (await hide.boundingBox())!;
  await hide.click();
  await expect(overview(page)).toHaveCount(0);
  await expect(show).toBeVisible();
  // The toggle stays put: Hide leads the overview's header where Show leads the title bar, once
  // the column has slid away.
  await expect
    .poll(async () => {
      const at = (await show.boundingBox())!;
      return Math.abs(at.x - shownAt.x) <= 1 && Math.abs(at.y - shownAt.y) <= 1;
    })
    .toBe(true);
  await expect(show).toHaveAccessibleName("Show sidebar");
  await expect(show).toHaveAttribute("title", /^Show sidebar\b.*B/);
  await expect.poll(() => storedOverview(page)).toBe("hidden");

  await show.click();
  await expect(overview(page)).toBeVisible();
  await expect(show).toHaveCount(0);
  await expect.poll(() => storedOverview(page)).toBeUndefined();

  // On a page with no composer, hiding hands the focus to the button that shows it again.
  await overview(page).getByLabel("New", { exact: true }).click();
  await page.getByTestId("new-entry-workspace").click();
  await expect(page).toHaveURL(/\/new-workspace$/);
  await overview(page).getByTestId("overview-hide").click();
  await expect(overview(page)).toHaveCount(0);
  await expect(show).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(overview(page)).toBeVisible();
});

test("an Open overview comes back Open after ⌘B, and stays beside the chat in a narrow window", async ({
  page,
}) => {
  await start(page, { layout: { overviewSidebar: "open" } });
  await composer(page).click();
  await page.keyboard.press("ControlOrMeta+b");
  await expect.poll(() => storedOverview(page)).toBe("hidden");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(overview(page)).toBeVisible();
  await expect.poll(() => storedOverview(page)).toBe("open");

  await page.setViewportSize({ width: 520, height: 900 });
  await expect(overview(page)).toBeVisible();
  const chat = page.locator("[data-pane-root]").first();
  expect((await chat.boundingBox())!.width).toBeGreaterThanOrEqual(340);
  const side = (await overview(page).boundingBox())!;
  const pane = (await chat.boundingBox())!;
  expect(side.x + side.width).toBeLessThanOrEqual(pane.x);
  expect(pane.x + pane.width).toBeLessThanOrEqual(520);

  // Narrowing borrows from the overview's displayed width, never its saved width or Glass insets.
  const savedWidth = (await storedLayout(page))["sidebarWidth"];
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await overview(page).boundingBox())!.width).toBe(248);
  expect((await storedLayout(page))["sidebarWidth"]).toBe(savedWidth);
});

test("a narrow window: Automatic is compact with the panel beside it at 1000 px, steps aside at 520 px, and ⌘B brings it back", async ({
  page,
}) => {
  await start(page, { width: 1000, panel: true });
  // At 1000 px the rail, a chat at least its narrowest and the right panel are side by side.
  await expect(rail(page)).toBeVisible();
  await expect(overview(page)).toHaveCount(0);
  await expect(page.getByTestId("right-panel")).toBeVisible();
  const chat = page.locator("main");
  expect((await chat.boundingBox())!.width).toBeGreaterThanOrEqual(360);
  const [side, panel] = await Promise.all([
    rail(page).boundingBox(),
    page.getByTestId("right-panel").boundingBox(),
  ]);
  expect(side!.width).toBeLessThanOrEqual(60);
  expect(side!.x + side!.width).toBeLessThanOrEqual((await chat.boundingBox())!.x + 1);
  expect(panel!.x).toBeGreaterThanOrEqual((await chat.boundingBox())!.x + 359);
  // The panel keeps its stored width beside the rail.
  expect(panel!.width).toBeGreaterThanOrEqual(352);

  // Too narrow for it beside the chat, it steps aside; ⌘B shows it, compact as automatic is here.
  await page.setViewportSize({ width: 520, height: 900 });
  await expect(rail(page)).toHaveCount(0);
  await composer(page).click();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(rail(page)).toBeVisible();
  // Asked for over its room, not picked: the setting stays automatic.
  expect(await storedOverview(page)).toBeUndefined();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(rail(page)).toHaveCount(0);
});

test("⌘B leaves focus mode with the overview shown", async ({ page }) => {
  await start(page);
  await composer(page).click();
  await page.keyboard.press("ControlOrMeta+Shift+Period");
  const shell = page.getByTestId("app-shell");
  await expect(shell).toHaveAttribute("data-focus-mode", "true");
  await expect(overview(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+b");
  await expect(shell).toHaveAttribute("data-focus-mode", "false");
  await expect(overview(page)).toBeVisible();
});

test("Settings → General's Overview sidebar row picks the mode the window lays out", async ({
  page,
}) => {
  await start(page);
  await composer(page).click();
  await page.keyboard.press("ControlOrMeta+Comma");
  const row = page.getByRole("radiogroup", { name: "Overview sidebar" });
  await expect(row).toBeVisible();
  await expect(row.getByRole("radio")).toHaveText(["Automatic", "Open", "Compact", "Hidden"]);
  await expect(row.getByRole("radio", { name: "Automatic" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("general-settings")).toContainText(
    "Automatic is open from 1280 px, compact below.",
  );
  await row.getByRole("radio", { name: "Hidden" }).click();
  await expect(overview(page)).toHaveCount(0);
  await expect.poll(() => storedOverview(page)).toBe("hidden");
  await row.getByRole("radio", { name: "Open" }).click();
  await expect(overview(page)).toBeVisible();
  await expect.poll(() => storedOverview(page)).toBe("open");
  await row.getByRole("radio", { name: "Compact" }).click();
  await expect(rail(page)).toBeVisible();
  await expect(overview(page)).toHaveCount(0);
  await expect.poll(() => storedOverview(page)).toBe("compact");
  await row.getByRole("radio", { name: "Automatic" }).click();
  await expect.poll(() => storedOverview(page)).toBeUndefined();
  await expect(overview(page)).toBeVisible();

  // Hidden with the focus inside it on a page without a pane, the focus goes to Show sidebar.
  await overview(page).getByTestId("overview-needs-you").focus();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(overview(page)).toHaveCount(0);
  await expect(page.getByTestId("overview-show")).toBeFocused();
});

// Compact: the rail of tiles, automatic below 1280 px.

test("Automatic is open at 1440 px and compact at 1100 px, its tiles saying what the rows say", async ({
  page,
}) => {
  const made = await start(page);
  await expect(overview(page)).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
  // What the open overview says: each workspace's line, its asks, Needs you and the solo threads.
  const rows = overview(page).getByTestId("overview-workspace");
  const ids: string[] = [];
  const labels: string[] = [];
  const asks: (string | null)[] = [];
  for (const row of await rows.all()) {
    ids.push((await row.getAttribute("data-workspace-id"))!);
    labels.push((await row.locator("button").first().getAttribute("aria-label"))!);
    const badge = row.getByTestId("overview-workspace-asks");
    asks.push((await badge.count()) > 0 ? await badge.textContent() : null);
  }
  expect(asks.some((each) => each !== null)).toBe(true);
  const needs = await overview(page).getByTestId("overview-needs-you").getAttribute("data-count");
  // As its title counts them: the rows draw only near the view.
  const title = overview(page).getByTestId("overview-section-solo").getByRole("button").first();
  const solo = Number((await title.getAttribute("aria-label"))?.match(/\d+$/)?.[0]);
  expect(solo).toBeGreaterThan(0);

  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(rail(page)).toBeVisible();
  await expect(overview(page)).toHaveCount(0);
  expect(await storedOverview(page)).toBeUndefined();
  const box = (await rail(page).boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(56);
  expect(box.width).toBeLessThanOrEqual(60);

  // A tile per workspace in the same order, each named as its row, its badge its ask count and
  // its count the workers at work its line counts.
  const tiles = rail(page).locator('[data-testid="overview-tile"][data-workspace-id]');
  await expect(tiles).toHaveCount(ids.length);
  for (const [index, id] of ids.entries()) {
    const each = tiles.nth(index);
    await expect(each).toHaveAttribute("data-workspace-id", id);
    await expect(each).toHaveAttribute("aria-label", labels[index]!);
    if (asks[index] === null) await expect(each.getByTestId("overview-tile-asks")).toHaveCount(0);
    else await expect(each.getByTestId("overview-tile-asks")).toHaveText(asks[index]!);
    const working = labels[index]!.match(/(\d+) working/)?.[1];
    if (working === undefined) await expect(each.getByTestId("overview-tile-count")).toHaveCount(0);
    else await expect(each.getByTestId("overview-tile-count")).toHaveText(working);
  }
  // The current one is marked; the name's first two letters mark each.
  await expect(tile(page, made.workspaceId)).toHaveAttribute("aria-current", "true");
  await expect(tile(page, made.asks.other.workspaceId)).not.toHaveAttribute("aria-current");
  // Needs you as the open overview counts it, opening its popover beside; then the solo threads' tile.
  const pill = rail(page).getByTestId("overview-rail-needs-you");
  await expect(pill).toHaveAttribute("data-count", needs!);
  await expect(pill).toHaveText(needs!);
  await expect(soloTile(page).getByTestId("overview-tile-count")).toHaveText(String(solo));
  await pill.click();
  await expect(page.getByTestId("needs-you-popover")).toBeVisible();
  await expect(page.getByTestId("needs-you-item")).not.toHaveCount(0);
});

test("a tile's flyout lists the current workspace's workers: a click opens one, ⌥-click peeks, ⌘-click keeps beside", async ({
  page,
}) => {
  const made = await start(page, { width: 1100 });
  await expect(rail(page)).toBeVisible();
  const live = await liveFromCards(page, made.workspaceId);
  await tile(page, made.workspaceId).hover();
  await expect(flyout(page)).toBeVisible();
  await expect(flyout(page)).toHaveAttribute("data-for", `workspace:${made.workspaceId}`);
  // The open overview's rows: the cards' live workers, feature by feature.
  const rows = flyout(page).getByTestId("overview-worker");
  const expected = live.flatMap((feature) => feature.workers);
  await expect(rows).toHaveCount(expected.length);
  for (const [at, each] of expected.entries()) {
    await expect(rows.nth(at)).toHaveAttribute("data-thread-id", each.id);
    await expect(rows.nth(at).getByTestId("overview-worker-title")).toHaveText(each.title);
  }
  await expect(flyout(page).getByTestId("overview-feature")).toHaveCount(live.length);

  // A plain click opens its thread, as the open row does; watching holds nothing.
  const before = await workerFacts(page, made, made.live);
  expect(before.held).toBe(false);
  const row = () => flyout(page).locator(`[data-thread-id="${made.live}"]`);
  await row().click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.live}$`));
  await expect(page.getByTestId("peek-sheet")).toHaveCount(0);
  await expect(flyout(page)).toHaveCount(0);
  expect(await workerFacts(page, made, made.live)).toEqual(before);

  // Its tile goes back to the orchestrator; ⌥-click there peeks, staying where it was.
  await page.mouse.move(600, 450);
  await tile(page, made.workspaceId).click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await page.mouse.move(600, 450);
  await tile(page, made.workspaceId).hover();
  await expect(flyout(page)).toBeVisible();
  await row().click({ modifiers: ["Alt"] });
  const sheet = page.getByTestId("peek-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute("data-kind", "worker");
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  expect(await workerFacts(page, made, made.live)).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  // Back on the tile it came from.
  await expect(tile(page, made.workspaceId)).toBeFocused();
  expect(await workerFacts(page, made, made.live)).toEqual(before);

  // ⌘-click keeps it beside the chat.
  await page.mouse.move(600, 450);
  await tile(page, made.workspaceId).hover();
  await expect(flyout(page)).toBeVisible();
  await row().click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByTestId("beside-dock")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  expect((await workerFacts(page, made, made.live)).held).toBe(false);
  await expect(flyout(page)).toHaveCount(0);

  // An asking worker's row opens its thread on what it asks.
  await page.mouse.move(600, 450);
  await tile(page, made.workspaceId).hover();
  const asking = flyout(page).locator(`[data-thread-id="${made.asks.choosing}"]`);
  await expect(asking).toHaveAttribute("data-asking", "true");
  await asking.click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.asks.choosing}$`));
  await expect(
    page.locator("main").getByTestId("approval-card").or(page.getByTestId("question-card")),
  ).toBeVisible();
});

test("the keyboard opens a tile's flyout, → goes in, Esc closes it back on the tile; a click switches", async ({
  page,
}) => {
  const made = await start(page, { width: 1100 });
  // From the rail's top, the arrows walk the tiles; a focused tile shows its flyout.
  await rail(page).getByTestId("overview-expand").focus();
  await page.keyboard.press("ArrowDown");
  await expect(rail(page).getByTestId("overview-rail-needs-you")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const first = rail(page).locator('[data-testid="overview-tile"]').first();
  await expect(first).toBeFocused();
  await expect(flyout(page)).toBeVisible();
  await expect(flyout(page)).toHaveAttribute(
    "data-for",
    `workspace:${await first.getAttribute("data-workspace-id")}`,
  );
  // Esc closes it, the focus staying on the tile.
  await page.keyboard.press("Escape");
  await expect(flyout(page)).toHaveCount(0);
  await expect(first).toBeFocused();

  // On the current workspace's tile, → goes to its first row, ↓ to the next; Esc comes back.
  await tile(page, made.workspaceId).focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ArrowRight");
  await expect(flyout(page)).toBeVisible();
  const rows = flyout(page).getByTestId("overview-worker");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(flyout(page)).toHaveCount(0);
  await expect(tile(page, made.workspaceId)).toBeFocused();
  // → goes in again, and ← closes it back on the tile.
  await page.keyboard.press("ArrowRight");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(flyout(page)).toHaveCount(0);
  await expect(tile(page, made.workspaceId)).toBeFocused();

  // Another workspace's flyout: its line, as the open overview folds it.
  const other = tile(page, made.asks.other.workspaceId);
  await other.hover();
  await expect(flyout(page)).toHaveAttribute(
    "data-for",
    `workspace:${made.asks.other.workspaceId}`,
  );
  await expect(flyout(page).getByTestId("overview-flyout-summary")).toContainText("1 ask");
  // The solo threads' tile lists them; a row opens one.
  await soloTile(page).hover();
  await expect(flyout(page)).toHaveAttribute("data-for", "solo");
  const flaky = flyout(page).locator('[data-testid="overview-solo"][data-thread-id="t-flaky"]');
  await expect(flaky).toContainText("Fix flaky");

  // A click on a tile switches to its workspace, as its row does.
  await other.click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.asks.other.orchestratorThreadId}$`));
  await expect(other).toHaveAttribute("aria-current", "true");
  await expect(tile(page, made.workspaceId)).not.toHaveAttribute("aria-current");
  // The click closed the flyout, and the switch doesn't open it again.
  await expect(flyout(page)).toHaveCount(0);
  await expect(composer(page)).toBeVisible();
  await expect(other).toBeFocused();
  await expect(flyout(page)).toHaveCount(0);
});

test("the Compact and Expand buttons pick the mode; ⌘B hides compact and brings it back compact", async ({
  page,
}) => {
  await start(page);
  await overview(page).getByTestId("overview-compact").click();
  await expect(rail(page)).toBeVisible();
  await expect(overview(page)).toHaveCount(0);
  await expect.poll(() => storedOverview(page)).toBe("compact");
  // The focus moves to the button that takes its place.
  await expect(rail(page).getByTestId("overview-expand")).toBeFocused();

  // ⌘B hides it, and shows it compact again.
  await page.keyboard.press("ControlOrMeta+b");
  await expect(rail(page)).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
  await expect.poll(() => storedOverview(page)).toBe("hidden");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(rail(page)).toBeVisible();
  await expect.poll(() => storedOverview(page)).toBe("compact");
  // Across a reload too.
  await page.keyboard.press("ControlOrMeta+b");
  await expect.poll(() => storedOverview(page)).toBe("hidden");
  await page.reload();
  await seed(page);
  await expect(rail(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+b");
  await expect(rail(page)).toBeVisible();
  await expect.poll(() => storedOverview(page)).toBe("compact");

  await rail(page).getByTestId("overview-expand").click();
  await expect(overview(page)).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
  await expect.poll(() => storedOverview(page)).toBe("open");
  await expect(overview(page).getByTestId("overview-compact")).toBeFocused();
});

test("⌘B hides an automatic compact overview, the focus going to the composer, and brings it back", async ({
  page,
}) => {
  await start(page, { width: 1100 });
  await expect(rail(page)).toBeVisible();
  await tile(
    page,
    (await rail(page).locator("[data-workspace-id]").first().getAttribute("data-workspace-id"))!,
  ).focus();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(rail(page)).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
  await expect.poll(() => storedOverview(page)).toBe("hidden");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(rail(page)).toBeVisible();
  await expect.poll(() => storedOverview(page)).toBeUndefined();

  // From a row in a tile's flyout too, though the flyout sits outside the rail on the page.
  const current = rail(page).locator('[data-testid="overview-tile"][aria-current="true"]');
  await current.focus();
  await page.keyboard.press("ArrowRight");
  await expect(flyout(page).getByTestId("overview-worker").first()).toBeFocused();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(rail(page)).toHaveCount(0);
  await expect(flyout(page)).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
  await expect.poll(() => storedOverview(page)).toBe("hidden");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(rail(page)).toBeVisible();
  await expect.poll(() => storedOverview(page)).toBeUndefined();

  // Usage and Settings sit in the rail, under its toggle, once; hidden, they go to the title bar.
  await expect(page.getByTestId("top-left-nav")).toHaveCount(1);
  const nav = rail(page).getByTestId("top-left-nav");
  await expect(nav.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  expect((await nav.boundingBox())!.width).toBeLessThanOrEqual(60);

  // The rail's Hide sidebar leads it, in the spot the title bar's Show sidebar then takes, which
  // brings it back compact.
  const hide = rail(page).getByTestId("overview-hide");
  const show = page.getByTestId("shell-titlebar").getByTestId("overview-show");
  await expect(show).toHaveCount(0);
  const hideAt = (await hide.boundingBox())!;
  const expandAt = (await rail(page).getByTestId("overview-expand").boundingBox())!;
  expect(hideAt.y).toBeLessThan(expandAt.y);
  await hide.click();
  await expect(rail(page)).toHaveCount(0);
  await expect(show).toBeVisible();
  await expect(page.getByTestId("shell-titlebar").getByTestId("top-left-nav")).toBeVisible();
  await expect
    .poll(async () => {
      const at = (await show.boundingBox())!;
      return Math.abs(at.x - hideAt.x) <= 1 && Math.abs(at.y - hideAt.y) <= 1;
    })
    .toBe(true);
  await show.click();
  await expect(rail(page)).toBeVisible();
  await expect(show).toHaveCount(0);
  await expect.poll(() => storedOverview(page)).toBeUndefined();
  // Wider again, automatic opens; the focus on the current tile goes to the current row.
  await current.focus();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(overview(page)).toBeVisible();
  const currentRow = overview(page).locator('[data-overview-stop][aria-current="true"]');
  await expect(currentRow).toBeFocused();
  // And back on the tile when the window narrows again.
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(rail(page)).toBeVisible();
  await expect(current).toBeFocused();
  // Left by a click on plain text, the focus drops to the page and stays there.
  await page.keyboard.press("Escape");
  await current.focus();
  await page.keyboard.press("Escape");
  await expect(current).toBeFocused();
  await page.getByTestId("shell-titlebar").click({ position: { x: 600, y: 10 } });
  const onPage = () => page.evaluate(() => document.activeElement === document.body);
  await expect.poll(onPage).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(overview(page)).toBeVisible();
  expect(await onPage()).toBe(true);
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(rail(page)).toBeVisible();
  // Focus elsewhere stays there across the change.
  await composer(page).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(overview(page)).toBeVisible();
  await expect(composer(page)).toBeFocused();
  // ⌘⌥S focuses the current tile in the rail.
  await page.setViewportSize({ width: 1100, height: 900 });
  await composer(page).click();
  await page.keyboard.press("ControlOrMeta+Alt+s");
  await expect(
    rail(page).locator('[data-testid="overview-tile"][aria-current="true"]'),
  ).toBeFocused();
});

test("the ring round a working orchestrator's tile breathes at full motion only", async ({
  page,
}) => {
  await start(page, { width: 1100 });
  const ring = rail(page).locator('[data-testid="overview-tile-ring"][data-working]').first();
  await expect(ring).toBeVisible();
  const animation = () => ring.evaluate((element) => getComputedStyle(element).animationName);
  await expect.poll(animation).toBe("gram-ring-breathe");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  await expect.poll(animation).toBe("none");
  // The ring still shows, still.
  expect(await ring.evaluate((element) => getComputedStyle(element).borderTopColor)).not.toBe(
    "rgba(0, 0, 0, 0)",
  );
});

test("a worker still running after its feature is delivered shows with its step and age", async ({
  page,
}) => {
  const made = await start(page);
  // Its card has it merged, so it had left the overview; a release step starts it running again.
  await expect(worker(page, made.doneToday)).toHaveCount(0);
  await page.evaluate((id) => {
    const mock = window.gramMock!;
    mock.simulateTurnPlan(id as never, [
      { content: "Merge the release PR", status: "completed" },
      { content: "Tag the release", status: "inProgress", activeForm: "Tagging the release" },
    ]);
    mock.simulateStatus(id as never, "running", "Running git tag v0.1.0");
  }, made.doneToday);
  const row = worker(page, made.doneToday);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("overview-worker-dot")).toHaveAttribute("data-working", "true");
  // One line: what it does, with the dot's "working" and its age in its name and hover card.
  await expect(row.getByTestId("overview-worker-now")).toHaveCount(0);
  const line = row.getByTestId("overview-worker-step");
  await expect(line).not.toHaveText("");
  await expect(line).toContainText(/Tagging the release|git tag/);
  await expect(row.getByTestId("overview-ago")).toHaveCount(0);
  await expect(row).toHaveAttribute("aria-label", /, working, .*last active \d{2}:\d{2}$/);
  // Its turn over, it leaves again.
  await page.evaluate((id) => window.gramMock!.simulateStatus(id as never, "idle"), made.doneToday);
  await expect(row).toHaveCount(0);
});

test("an orchestrator's line counts the same folded or open: its live workers, and as working the ones whose dots pulse", async ({
  page,
}) => {
  const made = await start(page);
  const here = workspaceRow(page, made.workspaceId);
  const count = here.getByTestId("overview-workspace-row");
  const rows = here.getByTestId("overview-worker");
  await expect(rows.first()).toBeVisible();
  const live = await rows.count();
  const working = await here.locator('[data-testid="overview-worker-dot"][data-working]').count();
  expect(working).toBeGreaterThan(0);
  const line = async () => {
    await expect(count).toHaveAttribute("data-live", String(live));
    await expect(count).toHaveAttribute("data-working", String(working));
    // Its only number is what needs you: the rest is on its hover and in its name.
    await expect(count).toHaveAttribute(
      "title",
      new RegExp(`^(\\w+( \\w+)? · )?${live} workers · ${working} working · `),
    );
    await expect(count).toHaveAttribute("aria-label", new RegExp(`, .*${working} working`));
    await expect(count).toHaveAttribute("title", /Worker slots \d+ of \d+/);
    await expect(here.getByTestId("overview-workspace-state")).toHaveCount(0);
    await expect(here.getByTestId("overview-workspace-workers")).toHaveCount(0);
  };
  await line();
  await here.getByTestId("overview-workspace-fold").click();
  await expect(rows.first()).toBeHidden();
  await line();
  await here.getByTestId("overview-workspace-fold").click();
  await expect(rows.first()).toBeVisible();

  // A worker whose turn ends leaves the count and its dot stops, in step.
  await page.evaluate((id) => window.gramMock!.simulateStatus(id as never, "idle"), made.live);
  await expect(worker(page, made.live).getByTestId("overview-worker-dot")).not.toHaveAttribute(
    "data-working",
  );
  const after = await here.locator('[data-testid="overview-worker-dot"][data-working]').count();
  await expect(count).toHaveAttribute("data-working", String(after));
});

test("a worker's PRs show as chips under its row, with checks and the review bot", async ({
  page,
}) => {
  const made = await start(page);
  // The queue worker has two PRs at different stages: its own, failing with the bot's blockers,
  // and a draft it follows in another repo, its checks and a bot round still running.
  await page.evaluate((id) => {
    const mock = window.gramMock!;
    const threads = { unresolved: 2, blockers: 2, suggestions: 0, outdatedUnresolved: 0 };
    const review = { bots: ["claude"], reviewedHead: true, roundInFlight: false, threads };
    const pr = {
      number: 214,
      state: "OPEN",
      url: "https://github.com/acme/api/pull/214",
      title: "Retry the queue with backoff",
      isDraft: false,
      checks: "failing",
      headMatches: true,
      aheadOfPr: false,
      review,
    };
    const draft = {
      ...pr,
      number: 48,
      url: "https://github.com/acme/web/pull/48",
      title: "Trigger form calls the endpoint",
      isDraft: true,
      checks: "pending",
      review: {
        ...review,
        roundInFlight: true,
        threads: { ...threads, unresolved: 0, blockers: 0 },
      },
    };
    mock.world.updateThread(
      id as never,
      { extraPrs: [{ repo: "acme/web", number: 48, monitor: false }] } as never,
    );
    mock.world.publishGit(
      id as never,
      {
        repo: true,
        branch: "feat/queue-retry",
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
        pr,
        extraPrs: [draft],
      } as never,
    );
  }, made.live);
  const chips = overview(page).locator(
    `[data-testid="overview-pr-chips"][data-thread-id="${made.live}"] [data-testid="overview-pr-chip"]`,
  );
  await expect(chips).toHaveCount(2);
  // Its own first, red for what blocks the merge; the draft stays grey while its round runs. The
  // worker runs, so its failing CI is its own to fix: a wrench, not the user's red ×. The bot's
  // blockers still tint the chip.
  await expect(chips.nth(0)).toHaveAttribute("data-pr", "214");
  await expect(chips.nth(0)).toHaveAttribute("data-tone", "danger");
  await expect(chips.nth(0).locator("[data-checks]")).toHaveAttribute("data-checks", "fixing");
  await expect(chips.nth(0).locator("[data-review]")).toHaveAttribute("data-review", "blockers");
  await expect(chips.nth(0)).toHaveAccessibleName(
    /PR #214 checks failing; its worker is fixing them.*2 blockers/,
  );
  await expect(chips.nth(1)).toHaveAttribute("data-pr", "48");
  await expect(chips.nth(1)).toHaveAttribute("data-state", "draft");
  await expect(chips.nth(1)).toHaveAttribute("data-tone", "plain");
  await expect(chips.nth(1).locator("[data-checks]")).toHaveAttribute("data-checks", "pending");
  await expect(chips.nth(1).locator("[data-review]")).toHaveAttribute("data-review", "inFlight");
  // Hovering one shows its card.
  await chips.nth(0).hover();
  await expect(page.getByTestId("overview-pr-card")).toContainText("Retry the queue with backoff");
  // From a chip the arrows go on through the overview's rows.
  await page.mouse.move(0, 0);
  await chips.nth(0).focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-overview-stop")))
    .toBe(true);
  await expect(chips.nth(0)).not.toBeFocused();
  // In the compact rail's flyout the chips are there, their names carrying what a card would say.
  await page.setViewportSize({ width: 1100, height: 900 });
  const current = rail(page).locator('[data-testid="overview-tile"][aria-current="true"]');
  await current.hover();
  const inFlyout = flyout(page).locator(
    `[data-testid="overview-pr-chips"][data-thread-id="${made.live}"] [data-testid="overview-pr-chip"]`,
  );
  await expect(inFlyout).toHaveCount(2);
  await inFlyout.nth(0).hover();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("overview-pr-card")).toHaveCount(0);
  await expect(flyout(page)).toBeVisible();
});

test("an orchestrator folds its workers by its chevron or ← and →, keeps their signals on its line, and stays folded across a reload", async ({
  page,
}) => {
  const made = await start(page);
  const here = workspaceRow(page, made.workspaceId);
  const line = here.getByTestId("overview-workspace-row");
  const chevron = here.getByTestId("overview-workspace-fold");
  const workers = here.getByTestId("overview-worker");
  const asksOf = async () =>
    Number((await here.getByTestId("overview-workspace-asks").textContent()) ?? "0");
  await expect(line).toHaveAttribute("aria-expanded", "true");
  await expect(chevron).toHaveAttribute("aria-expanded", "true");
  await expect(workers.first()).toBeVisible();
  const live = await workers.count();
  expect(live).toBeGreaterThan(1);
  // Open, the line has the count it keeps folded.
  await expect(line).toHaveAttribute("data-live", String(live));
  const asks = await asksOf();
  expect(asks).toBeGreaterThan(0);

  // Open a worker, so a click on the line shows it still opens the orchestrator.
  await worker(page, made.live).click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.live}$`));

  // The chevron folds: the workers hide, the line keeps their count, its asks and who works.
  await chevron.click();
  await expect(line).toHaveAttribute("aria-expanded", "false");
  await expect(chevron).toHaveAttribute("aria-expanded", "false");
  await expect(chevron).toHaveAccessibleName(/^Show .+'s workers$/);
  await expect(here).toHaveAttribute("data-folded", "true");
  await expect(workers.first()).toBeHidden();
  await expect(line).toHaveAttribute("data-live", String(live));
  expect(await asksOf()).toBe(asks);
  await expect(line).toHaveAttribute("title", new RegExp(`${live} workers · .*${asks} needs? you`));
  await expect(page).toHaveURL(new RegExp(`/t/${made.live}$`));

  // The line's click opens the orchestrator as before, and leaves the fold as it is.
  await line.click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(line).toHaveAttribute("aria-expanded", "false");

  // A worker newly asking doesn't open it: the line's count says so.
  await page.evaluate(
    (threadId) =>
      window.gramMock!.simulateRequest(threadId as never, {
        kind: "approval",
        id: "r-fold" as never,
        toolName: "Bash",
        displayName: "Bash",
        input: { command: "git push" },
        suggestions: [],
        scopes: ["once"],
      }),
    made.live,
  );
  await expect.poll(asksOf).toBe(asks + 1);
  await expect(line).toHaveAttribute("aria-expanded", "false");
  await expect(workers.first()).toBeHidden();

  // → opens it from the keyboard and ← folds it again; ↓ then skips the hidden workers.
  await line.focus();
  await page.keyboard.press("ArrowRight");
  await expect(line).toHaveAttribute("aria-expanded", "true");
  await expect(workers.first()).toBeVisible();
  await expect(line).toHaveAttribute("data-live", String(live));
  await page.keyboard.press("ArrowRight");
  await expect(line).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(line).toHaveAttribute("aria-expanded", "false");
  await expect(line).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(overview(page).locator(":focus")).not.toHaveAttribute(
    "data-testid",
    "overview-worker",
  );

  // Kept per workspace across a reload: this one folded, the other as it was.
  const other = workspaceRow(page, made.asks.other.workspaceId);
  await expect(other.getByTestId("overview-workspace-row")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.reload();
  await seed(page);
  await expect(line).toHaveAttribute("aria-expanded", "false");
  await expect(workers.first()).toBeHidden();
  await expect(other.getByTestId("overview-workspace-row")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(other.getByTestId("overview-worker").first()).toBeVisible();

  // ⌘J opens it to reach its first worker.
  await page.keyboard.press("ControlOrMeta+j");
  await expect(line).toHaveAttribute("aria-expanded", "true");
  await expect(workers.first()).toBeFocused();
});

test("a solo thread at work trades its age for a pulsing dot, and can't be marked done until it rests", async ({
  page,
}) => {
  await start(page);
  // A thread no mock script plays: a script moves its thread's status under the test.
  const id = "t-release";
  const row = threadRow(page, id);
  await expect(row).toBeVisible();
  const dot = row.locator("[data-working]");
  const age = row.locator("span.tabular-nums");
  await page.evaluate((threadId) => {
    window.gramMock!.simulateStatus(threadId as never, "idle");
  }, id);
  await expect(age).toBeVisible();
  await expect(dot).toHaveCount(0);

  await page.evaluate((threadId) => {
    window.gramMock!.simulateStatus(threadId as never, "running", "Running bun test");
  }, id);
  await expect(dot).toHaveCount(1);
  await expect(age).toHaveCount(0);
  // Off the row, its last activity stays on its hover and in its name.
  await expect(row).toHaveAttribute("title", /^Last activity \d{2}:\d{2}$/);
  await expect(row).toHaveAttribute("aria-label", /, Working, Last activity \d{2}:\d{2}$/);

  await row.click({ button: "right" });
  await expect(page.getByTestId("menu-done")).toHaveAttribute("data-disabled", /.*/);
  await expect(page.getByTestId("menu-done")).toHaveText("Mark done after it stops");
  await page.keyboard.press("Escape");

  await page.evaluate((threadId) => {
    window.gramMock!.simulateStatus(threadId as never, "idle");
  }, id);
  await expect(age).toBeVisible();
  await row.click({ button: "right" });
  await expect(page.getByTestId("menu-done")).not.toHaveAttribute("data-disabled");
  await expect(page.getByTestId("menu-done")).toHaveText("Mark done");
  await page.keyboard.press("Escape");
});
