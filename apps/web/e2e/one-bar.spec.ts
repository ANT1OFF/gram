import { expect, test, type Page } from "@playwright/test";

import { closeMenus } from "./titlebar-menu";

// One bar, everywhere: the title bar carries a thread's header when the grid shows it alone in
// Chat, an orchestrator's and a worker's as well as a solo thread's, and Board's controls on Board.
// The branch is the agents' working detail and stays out of it and its menu, in More…. The bar's
// right end is few icons: what wants you (usage, the bell) and the view (one "…" and the panel).
// The "…" holds, in words with their shortcuts, the thread's menu and Contents, the workspace's
// Workers, Tidy up, Pause, Memory and settings, and Quiet, focus mode, History and the layout.
// Narrow, the bar folds a worker's own actions into that "…" too. Mock state lives in memory, so
// every step after the seed stays in the app.

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

/** Escape out of the bar's open `submenu`, leaving the "…" open for the next. */
const stepBack = async (page: Page, submenu: string) => {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(submenu)).toBeHidden();
  await expect(page.getByTestId("titlebar-overflow-menu")).toBeVisible();
};
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
    "usage-meter",
    "titlebar-overflow",
  ]) {
    await expect(bar.getByTestId(testId)).toBeVisible();
  }
  // Few controls: Workers, Tidy up, Pause, Memory, the workspace's settings, Contents and the
  // thread's menu are the one "…"'s, as are Quiet, the layout and focus mode.
  for (const testId of [
    "workers-button",
    "titlebar-tidy",
    "titlebar-pause",
    "orchestrator-workspace-settings",
  ]) {
    await expect(bar.getByTestId(testId)).toHaveCount(0);
  }
  for (const name of ["Memory", "Contents", "Thread menu", "Workspace settings"]) {
    await expect(bar.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(bar.getByRole("link", { name, exact: true })).toHaveCount(0);
  }
  await expect(bar.getByRole("button", { name: /^Quiet|^Layout|^Focus mode/ })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: /^More/ })).toHaveCount(1);
  // Right of the title: usage (the sidebar's pill is the Inbox's one way in beside it), then the
  // "…" and the panel, told apart by the room between them.
  await expect(bar.getByTestId("titlebar-attention").getByRole("button")).toHaveCount(1);
  await expect(bar.getByTestId("titlebar-view").getByRole("button")).toHaveCount(2);
  const box = async (testId: string) => (await bar.getByTestId(testId).boundingBox())!;
  const attention = await box("titlebar-attention");
  const view = await box("titlebar-view");
  expect(view.x - (attention.x + attention.width)).toBeGreaterThanOrEqual(12);
  // Each icon names itself and its shortcut on hover, at once; the switcher says it switches.
  const tooltip = page.locator('[data-slot="tooltip-content"][data-open]');
  for (const [control, text] of [
    [bar.getByTestId("workspace-switcher-button"), /^Switch workspace \(.+1(–.+\d)?\)$/],
    [bar.getByRole("button", { name: /right panel$/ }), /^(Show|Hide) right panel \(.+\)$/],
    [
      bar.getByTestId("titlebar-overflow"),
      /^More\s*The thread's, the workspace's and the window's controls\s*Every place and command: .+K$/,
    ],
  ] as const) {
    await control.hover();
    await expect(tooltip).toHaveText(text);
    await page.mouse.move(0, 400);
    await expect(tooltip).toHaveCount(0);
  }
  // The "…" says each in words, with its shortcut where it has one, and like every menu keeps to
  // seven items: the thread's, the workspace's and the window's are submenus, Workers beside them.
  await bar.getByTestId("titlebar-overflow").click();
  const more = page.getByTestId("titlebar-overflow-menu");
  await expect(more.getByRole("menuitem")).toHaveText([
    /^Orchestrator/,
    /^Workers.*\d+ now.*J$/,
    /^Workspace/,
    /^View/,
  ]);
  await more.getByTestId("menu-thread").click();
  const threadGroup = page.getByTestId("titlebar-menu-thread");
  await expect(threadGroup.getByRole("menuitem", { name: /^Switch/ })).toBeVisible();
  await expect(threadGroup.getByRole("menuitem", { name: "More…" })).toBeVisible();
  // One submenu at a time: Escape steps back out of the last before the next opens.
  await stepBack(page, "titlebar-menu-thread");
  await more.getByTestId("menu-workspace").click();
  const workspaceGroup = page.getByTestId("titlebar-menu-workspace");
  for (const name of [/^Tidy up/, /^Pause workspace/, /^Memory$/, /^Workspace settings$/]) {
    await expect(workspaceGroup.getByRole("menuitem", { name })).toBeVisible();
  }
  await stepBack(page, "titlebar-menu-workspace");
  await more.getByTestId("menu-view").click();
  const viewGroup = page.getByTestId("titlebar-menu-view");
  // Contents joins them once the thread has prompts or chapters to list: this one has none yet.
  await expect(viewGroup.getByTestId("menu-contents")).toHaveCount(0);
  for (const name of [/^Quiet/, /^Focus mode/, /^History/]) {
    await expect(viewGroup.getByRole("menuitem", { name })).toBeVisible();
  }
  await expect(viewGroup.getByRole("menuitemradio")).toHaveCount(6);
  await expect(viewGroup.getByTestId("menu-history")).toContainText("H");
  await closeMenus(page);
  await expect(more).toBeHidden();
  // Beside the sidebar, its pill is the one way into the Inbox: the bar has none.
  await expect(bar.getByRole("button", { name: /^Inbox/ })).toHaveCount(0);
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

  // Board: its controls are the bar's, and the "…"'s Tidy up and Pause are Board's.
  await page.keyboard.press("ControlOrMeta+Alt+2");
  await expect(bar).toHaveAttribute("data-carries", "board");
  await expect(bar.getByTestId("board-header").getByTestId("rail-waiting-chip")).toBeVisible();
  await expect(bar.getByTestId("pane-header")).toHaveCount(0);
  await bar.getByTestId("titlebar-overflow").click();
  await expect(more.getByTestId("menu-thread")).toHaveCount(0);
  await more.getByTestId("menu-workspace").click();
  await expect(page.getByTestId("folded-tidy")).toBeVisible();
  await expect(page.getByTestId("folded-pause")).toBeVisible();
  await closeMenus(page);
  await expect(page.getByTestId("board-header")).toHaveCount(1);
  await expect(page.getByTestId("rail-board").getByTestId("board-header")).toHaveCount(0);
  await fitsTheBar(page);
  await page.keyboard.press("ControlOrMeta+Alt+1");

  // A worker: its crumbs, Open beside and Take over in the bar, and its branch in More… only.
  await routeTo(page, `/t/${made.inReview}`);
  await expect(bar.getByTestId("worker-crumbs")).toBeVisible();
  await expect(bar.getByTestId("worker-crumb-feature")).toBeVisible();
  await expect(bar.getByTestId("worker-take-over")).toBeVisible();
  await expect(bar.getByTestId("view-switcher")).toBeVisible();
  await expect(bar.getByTestId("branch-chip")).toHaveCount(0);
  await bar.getByTestId("titlebar-overflow").click();
  await more.getByTestId("menu-thread").click();
  await expect(page.getByTestId("titlebar-menu-thread")).toBeVisible();
  await expect(page.getByTestId("titlebar-menu-thread").getByTestId("branch-chip")).toHaveCount(0);
  await closeMenus(page);
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
  await bar.getByTestId("titlebar-overflow").click();
  // A solo thread's "…" has no workspace's controls.
  await expect(more.getByTestId("menu-workspace")).toHaveCount(0);
  await expect(more.getByTestId("folded-workers")).toHaveCount(0);
  await more.getByTestId("menu-thread").click();
  const soloMenu = page.getByTestId("titlebar-menu-thread");
  await expect(soloMenu).toBeVisible();
  await expect(soloMenu).not.toContainText("fix/flaky-retry");
  // More… has it, to copy.
  await soloMenu.getByTestId("menu-more").click();
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

test("narrow, the title truncates, a worker's actions fold into the bar's \"…\", and nothing leaves the bar", async ({
  page,
}) => {
  const made = await start(page, 700);
  const bar = titlebar(page);
  const overflow = bar.getByTestId("titlebar-overflow");
  const folded = page.getByTestId("titlebar-folded");

  // At 700 px the orchestrator's bar folds nothing: its few controls fit beside the title, and
  // Workers, Tidy up, Quiet, the layout and focus mode are the "…"'s whatever the width.
  await routeTo(page, `/t/${made.orchestratorThreadId}`);
  await expect(bar.getByTestId("pane-header")).toBeVisible();
  await expect(bar).not.toHaveAttribute("data-fold");
  await expect(bar.getByTestId("view-switcher")).toBeVisible();
  await expect(bar.getByTestId("titlebar-tidy")).toHaveCount(0);
  await expect(bar.getByRole("button", { name: /^Workers\b/ })).toHaveCount(0);
  await fitsTheBar(page);
  await overflow.click();
  await expect(folded.getByTestId("menu-thread")).toBeVisible();
  await expect(folded.getByTestId("menu-workspace")).toBeVisible();
  await expect(folded.getByTestId("folded-workers")).toBeVisible();
  // Each does what its button did.
  await folded.getByTestId("menu-view").click();
  await page.getByTestId("folded-focus").click();
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-focus-mode", "true");
  await page.keyboard.press("ControlOrMeta+Shift+Period");
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-focus-mode", "false");

  // Narrower, the bar folds all it can, and still holds its few controls.
  await page.setViewportSize({ width: 600, height: 720 });
  await expect(bar).toHaveAttribute("data-fold", "2");
  await expect(bar.getByTestId("view-switcher")).toBeVisible();
  await fitsTheBar(page);
  await overflow.click();
  await expect(folded.getByTestId("menu-workspace")).toBeVisible();
  await expect(folded.getByTestId("folded-workers")).toBeVisible();
  await folded.getByTestId("folded-workers").click();
  await expect(page.getByTestId("workers-list")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("workers-list")).toBeHidden();

  // A worker keeps its name, a few letters at least; Open beside and Take over are in the "…".
  await routeTo(page, `/t/${made.inReview}`);
  const worker = bar.getByTestId("worker-crumb-worker");
  await expect(worker).toBeVisible();
  expect((await worker.boundingBox())!.width).toBeGreaterThanOrEqual(40);
  await expect(bar.getByTestId("worker-take-over")).toBeHidden();
  await fitsTheBar(page);
  await overflow.click();
  await expect(page.getByTestId("menu-take-over")).toBeVisible();
  await page.keyboard.press("Escape");

  // Board's Tidy up is in the same "…".
  await page.keyboard.press("ControlOrMeta+Alt+2");
  await expect(bar.getByTestId("board-header")).toBeVisible();
  await expect(bar).toHaveAttribute("data-fold", "2");
  await fitsTheBar(page);
  await overflow.click();
  await page.getByTestId("menu-workspace").click();
  await expect(
    page.getByTestId("titlebar-menu-workspace").getByTestId("folded-tidy"),
  ).toBeVisible();
  // Its Grid or Lanes is under View.
  await stepBack(page, "titlebar-menu-workspace");
  await page.getByTestId("menu-view").click();
  await expect(
    page.getByTestId("titlebar-menu-view").getByTestId("folded-board-layout"),
  ).toBeVisible();
  await closeMenus(page);
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
  await overflow.click({ trial: true, timeout: 2000 });
});
