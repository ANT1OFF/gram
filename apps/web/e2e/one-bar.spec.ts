import { expect, test, type Page } from "@playwright/test";

// One bar, everywhere: the title bar carries a thread's header when the grid shows it alone in
// Chat, an orchestrator's and a worker's as well as a solo thread's, and Board's controls on Board.
// The branch is the agents' working detail and stays out of it and its thread menu, in More…. The
// bar's right end is three clusters: the workspace's work, attention, and the view, whose "…" holds
// Quiet, focus mode and the layout. Narrow, the bar folds Tidy up into that "…", then Workers. Mock
// state lives in memory, so every step after the seed stays in the app.

const MOCK_SETTINGS_KEY = "gram.mock.settings";

const start = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 720 });
  await page.addInitScript(
    ([key]) => {
      if (sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(
          key,
          JSON.stringify({ appearance: { mode: "system" }, panel: { open: false } }),
        );
      }
    },
    [MOCK_SETTINGS_KEY] as const,
  );
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  return page.evaluate(async () => {
    const mock = window.gramMock!;
    const made = await mock.simulateOrchestration("board");
    mock.simulateWaitOnUser(made.orchestratorThreadId, {
      kind: "action",
      title: "Run the release",
    });
    return made;
  });
};

/** Goes to `path` in the app's router, as a link does: no reload, so the mock's world stays. */
const routeTo = (page: Page, path: string) =>
  page.evaluate((to) => {
    history.pushState(history.state, "", to);
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, path);

const titlebar = (page: Page) => page.getByTestId("shell-titlebar");
const pane = (page: Page) => page.getByTestId("pane").first();

/** The window drag region an element is in, as Electron reads it. */
const appRegion = (page: Page, testId: string) =>
  page
    .getByTestId(testId)
    .first()
    .evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"));

/** Nothing in the bar is wider than it, and its last control is inside it. */
const fitsTheBar = async (page: Page) => {
  const bar = titlebar(page);
  await expect
    .poll(() => bar.evaluate((el) => el.scrollWidth - el.clientWidth), {
      message: "title bar content wider than the bar",
    })
    .toBeLessThanOrEqual(0);
  const barBox = (await bar.boundingBox())!;
  const last = bar.getByRole("button", { name: /right panel$/ });
  const lastBox = (await last.boundingBox())!;
  expect(lastBox.x + lastBox.width).toBeLessThanOrEqual(barBox.x + barBox.width);
  // What the bar carries doesn't run under the window's controls, nor anything in it past its end.
  const divider = bar.getByTestId("titlebar-divider");
  if ((await divider.count()) > 0) {
    const edge = (await divider.boundingBox())!.x;
    const carried = bar.getByTestId("titlebar-slot");
    const slotBox = (await carried.boundingBox())!;
    expect(slotBox.x + slotBox.width).toBeLessThanOrEqual(edge);
    // The bar folds a frame after what it carries changes; a pixel of rounding, as its measure
    // allows. The header itself: a needs-you ring may stand past it on purpose.
    const header = carried.locator("header").first();
    await expect
      .poll(() => header.evaluate((el) => el.scrollWidth - el.clientWidth), {
        message: "the header's controls run past its end",
      })
      .toBeLessThanOrEqual(1);
  }
};

test("an orchestrator, a worker, Board and a solo thread each have one bar with every control", async ({
  page,
}) => {
  // Wide enough for every control unfolded beside the worker's feature crumb.
  const made = await start(page, 1680);
  const bar = titlebar(page);

  // The orchestrator: its header is the bar's, beside the workspace's switcher and views.
  await routeTo(page, `/t/${made.orchestratorThreadId}`);
  await expect(bar).toHaveAttribute("data-carries", "thread");
  const header = bar.getByTestId("pane-header");
  await expect(header.getByRole("heading", { level: 1 })).toHaveAccessibleName(
    "Orchestrator: agent-platform",
  );
  await expect(pane(page).getByTestId("pane-header")).toHaveCount(0);
  await expect(page.getByTestId("pane-header")).toHaveCount(1);
  const barBox = (await bar.boundingBox())!;
  const paneBox = (await pane(page).boundingBox())!;
  expect(Math.round(paneBox.y)).toBeLessThanOrEqual(Math.round(barBox.y + barBox.height) + 1);
  for (const testId of [
    "workspace-switcher-button",
    "view-switcher",
    "workers-button",
    "titlebar-tidy",
    "titlebar-pause",
    "usage-meter",
    "titlebar-overflow",
  ]) {
    await expect(bar.getByTestId(testId)).toBeVisible();
  }
  // Quiet, the layout and focus mode are the "…"'s, not buttons of their own.
  await expect(bar.getByRole("button", { name: /^Quiet|^Layout|^Focus mode/ })).toHaveCount(0);
  // The clusters are told apart by the room between them, wider than within one.
  const box = async (testId: string) => (await bar.getByTestId(testId).boundingBox())!;
  const work = await box("titlebar-workspace");
  const attention = await box("titlebar-attention");
  const view = await box("titlebar-view");
  expect(attention.x - (work.x + work.width)).toBeGreaterThanOrEqual(12);
  expect(view.x - (attention.x + attention.width)).toBeGreaterThanOrEqual(12);
  // Each icon names itself and its shortcut on hover, at once; the switcher says it switches.
  const tooltip = page.locator('[data-slot="tooltip-content"][data-open]');
  for (const [control, text] of [
    [bar.getByTestId("workspace-switcher-button"), /^Switch workspace \(.+1(–.+\d)?\)$/],
    [bar.getByRole("button", { name: /right panel$/ }), /^(Show|Hide) right panel \(.+\)$/],
    [bar.getByTestId("workers-button"), /^Workers, \d+ now \(.+J\)$/],
    [bar.getByTestId("titlebar-overflow"), /^More window controls\s*Quiet, focus mode and layout$/],
  ] as const) {
    await control.hover();
    await expect(tooltip).toHaveText(text);
    await page.mouse.move(0, 400);
    await expect(tooltip).toHaveCount(0);
  }
  await expect(bar.getByRole("button", { name: /^Inbox/ })).toBeVisible();
  await expect(bar.getByRole("button", { name: /right panel$/ })).toBeVisible();
  await expect(header.getByTestId("pane-status")).toBeVisible();
  // Chat · Board are right there, so the header has no board button of its own.
  await expect(header.getByRole("button", { name: "Open board" })).toHaveCount(0);
  // The waiting strip is the thread's content, under the bar.
  await expect(pane(page).getByTestId("waiting-tray")).toBeVisible();
  await expect(bar.getByTestId("branch-chip")).toHaveCount(0);

  // The title and the empty room move the window; the controls take clicks.
  expect(await appRegion(page, "shell-titlebar")).toBe("drag");
  expect(await appRegion(page, "pane-header-chips")).toBe("no-drag");
  expect(await appRegion(page, "pane-status")).toBe("no-drag");
  expect(await appRegion(page, "view-switcher")).toBe("no-drag");
  await fitsTheBar(page);

  // Board: its controls are the bar's, and the bar's Tidy up and Pause are Board's.
  await page.keyboard.press("ControlOrMeta+Alt+2");
  await expect(bar).toHaveAttribute("data-carries", "board");
  await expect(bar.getByTestId("board-header").getByTestId("rail-waiting-chip")).toBeVisible();
  await expect(bar.getByTestId("pane-header")).toHaveCount(0);
  await expect(bar.getByTestId("titlebar-tidy")).toHaveCount(1);
  await expect(bar.getByTestId("titlebar-pause")).toHaveCount(1);
  await expect(page.getByTestId("board-header")).toHaveCount(1);
  await expect(page.getByTestId("rail-board").getByTestId("board-header")).toHaveCount(0);
  await fitsTheBar(page);
  await page.keyboard.press("ControlOrMeta+Alt+1");

  // A worker: its crumbs, Keep beside and Take over in the bar, and its branch in More… only.
  await routeTo(page, `/t/${made.inReview}`);
  await expect(bar.getByTestId("worker-crumbs")).toBeVisible();
  await expect(bar.getByTestId("worker-crumb-feature")).toBeVisible();
  await expect(bar.getByTestId("worker-take-over")).toBeVisible();
  await expect(bar.getByTestId("view-switcher")).toBeVisible();
  await expect(bar.getByTestId("branch-chip")).toHaveCount(0);
  await bar.getByRole("button", { name: "Thread menu" }).click();
  await expect(page.getByTestId("thread-menu").getByTestId("branch-chip")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await fitsTheBar(page);

  // A solo thread: no workspace views or orchestration buttons, which act on work it isn't part of.
  await routeTo(page, "/t/t-flaky");
  await expect(bar).toHaveAttribute("data-solo-thread", "true");
  await expect(bar.getByTestId("pane-header").getByRole("heading", { level: 1 })).toContainText(
    "Fix flaky retry test",
  );
  await expect(bar.getByTestId("view-switcher")).toHaveCount(0);
  await expect(bar.getByTestId("workers-button")).toHaveCount(0);
  await expect(bar.getByTestId("titlebar-tidy")).toHaveCount(0);
  await expect(bar.getByTestId("titlebar-pause")).toHaveCount(0);
  await expect(bar.getByTestId("branch-chip")).toHaveCount(0);
  await bar.getByRole("button", { name: "Thread menu" }).click();
  await expect(page.getByTestId("thread-menu")).toBeVisible();
  await expect(page.getByTestId("thread-menu")).not.toContainText("fix/flaky-retry");
  // More… has it, to copy.
  await page.getByTestId("thread-menu").getByTestId("menu-more").click();
  const palette = page.getByTestId("command-palette");
  await expect(palette.getByRole("option", { name: "Copy fix/flaky-retry" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  // Board brings Chat · Board back for a solo thread too, to go back by.
  await page.keyboard.press("ControlOrMeta+Alt+2");
  await expect(bar.getByTestId("view-switcher")).toBeVisible();
  await expect(bar).not.toHaveAttribute("data-solo-thread");
  await bar
    .getByTestId("view-switcher")
    .getByRole("radio", { name: /^Chat\b/ })
    .click();
  await expect(bar.getByTestId("pane-header")).toBeVisible();
  await expect(bar.getByTestId("view-switcher")).toHaveCount(0);
});

test('narrow, the title truncates, Tidy up and Workers fold into the bar\'s "…", and nothing leaves the bar', async ({
  page,
}) => {
  const made = await start(page, 700);
  const bar = titlebar(page);
  const overflow = bar.getByTestId("titlebar-overflow");
  const folded = page.getByTestId("titlebar-folded");

  // At 700 px the orchestrator's bar folds nothing: Quiet, the layout and focus mode are already
  // the "…"'s.
  await routeTo(page, `/t/${made.orchestratorThreadId}`);
  await expect(bar.getByTestId("pane-header")).toBeVisible();
  await expect(bar).not.toHaveAttribute("data-fold");
  await expect(bar.getByTestId("titlebar-tidy")).toBeVisible();
  await expect(bar.getByRole("button", { name: /^Workers, / })).toBeVisible();
  await expect(bar.getByTestId("titlebar-pause")).toBeVisible();
  await expect(bar.getByTestId("view-switcher")).toBeVisible();
  await fitsTheBar(page);
  await overflow.click();
  await expect(folded.getByTestId("folded-layout")).toBeVisible();
  await expect(folded.getByTestId("folded-tidy")).toHaveCount(0);
  await expect(folded.getByTestId("folded-workers")).toHaveCount(0);
  // Each does what its button did.
  await folded.getByTestId("folded-focus").click();
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-focus-mode", "true");
  await page.keyboard.press("ControlOrMeta+Shift+Period");
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-focus-mode", "false");
  // The thread menu has none of the bar's.
  await bar.getByRole("button", { name: "Thread menu" }).click();
  await expect(page.getByTestId("thread-menu")).toBeVisible();
  await expect(page.getByTestId("titlebar-folded")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Narrower, Tidy up and Workers fold too. Their measuring copies stay laid out, out of reach of
  // role queries.
  await page.setViewportSize({ width: 600, height: 720 });
  await expect(bar).toHaveAttribute("data-fold", "2");
  await expect(bar.getByTestId("titlebar-tidy")).toBeHidden();
  await expect(bar.getByTestId("workers-button")).toBeHidden();
  await expect(bar.getByRole("button", { name: /^Workers\b/ })).toHaveCount(0);
  await expect(bar.getByTestId("titlebar-pause")).toBeVisible();
  await fitsTheBar(page);
  await overflow.click();
  await expect(folded.getByTestId("folded-tidy")).toBeVisible();
  await expect(folded.getByTestId("folded-workers")).toBeVisible();
  await folded.getByTestId("folded-workers").click();
  await expect(page.getByTestId("workers-list")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("workers-list")).toBeHidden();

  // A worker keeps its name, a few letters at least; Keep beside and Take over are in the "…".
  await routeTo(page, `/t/${made.inReview}`);
  const worker = bar.getByTestId("worker-crumb-worker");
  await expect(worker).toBeVisible();
  expect((await worker.boundingBox())!.width).toBeGreaterThanOrEqual(40);
  await expect(bar.getByTestId("worker-take-over")).toBeHidden();
  await fitsTheBar(page);
  await overflow.click();
  await expect(page.getByTestId("menu-take-over")).toBeVisible();
  await page.keyboard.press("Escape");

  // Board's folded Tidy up is in the same "…".
  await page.keyboard.press("ControlOrMeta+Alt+2");
  await expect(bar.getByTestId("board-header")).toBeVisible();
  await expect(bar).toHaveAttribute("data-fold", "2");
  await fitsTheBar(page);
  await overflow.click();
  await expect(page.getByTestId("titlebar-overflow-menu").getByTestId("folded-tidy")).toBeVisible();
  // So is its Grid or Lanes.
  await expect(
    page.getByTestId("titlebar-overflow-menu").getByTestId("folded-board-layout"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+Alt+1");
  await page.setViewportSize({ width: 640, height: 720 });

  // A solo thread's title truncates first.
  await routeTo(page, "/t/t-flaky");
  const title = bar
    .getByTestId("pane-header")
    .getByRole("heading", { level: 1 })
    .locator("span.truncate");
  await expect(title).toBeVisible();
  await fitsTheBar(page);
  const menu = bar.getByRole("button", { name: "Thread menu" });
  await menu.click({ trial: true, timeout: 2000 });
});
