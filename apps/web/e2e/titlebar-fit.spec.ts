import { expect, test, type Page } from "@playwright/test";

import { seedDesktopShell } from "./desktop-shell-fixture";

// The title bar at its narrowest: both side panes open and dragged to their limits, so the chat is
// as narrow as the panes leave it, in a macOS window whose buttons take the bar's left while no
// sidebar is beside it. Narrowing, the bar folds into its "…" (a worker's actions, then the icons
// with an item there, then Chat · Board and Settings) and nothing in it runs over anything else,
// past its end or under the window's buttons, with Conversation only on or off. Mock state lives
// in memory, so every step after the seed stays in the app.

const MOCK_SETTINGS_KEY = "gram.mock.settings";

const start = async (page: Page, width: number) => {
  await seedDesktopShell(page, {});
  await page.setViewportSize({ width, height: 800 });
  await page.addInitScript(
    ([key]) => {
      if (sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(
          key,
          JSON.stringify({
            panel: { open: true, tab: "files" },
            layout: { overviewSidebar: "open" },
          }),
        );
      }
    },
    [MOCK_SETTINGS_KEY] as const,
  );
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  return page.evaluate(() => window.gramMock!.simulateOrchestration("board"));
};

/** Goes to `path` in the app's router, as a link does: no reload, so the mock's world stays. */
const routeTo = (page: Page, path: string) =>
  page.evaluate((to) => {
    history.pushState(history.state, "", to);
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, path);

/** Drags a side pane's edge by `dx`, as far as its bounds let it. */
async function dragEdge(page: Page, testId: string, dx: number) {
  const box = (await page.getByTestId(testId).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

/**
 * What in the bar runs over something else, past the bar's end, or under macOS's window buttons,
 * by the controls' boxes. Folded parts are inert and out of the count; the header's chips that
 * wrapped out of sight are hidden on purpose.
 */
const clashes = (page: Page) =>
  page.getByTestId("shell-titlebar").evaluate((bar) => {
    const box = bar.getBoundingClientRect();
    const lights =
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--window-lights-inset"),
      ) || 0;
    const controls = [
      ...bar.querySelectorAll<HTMLElement>(
        'button, a[href], [data-testid="pane-status"], [data-testid="pane-header-chips"] > *',
      ),
    ].filter((el) => {
      if (el.closest("[inert]") || !el.checkVisibility({ visibilityProperty: true })) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1) return false;
      const chips = el.closest('[data-testid="pane-header-chips"]');
      return chips === null || r.top < chips.getBoundingClientRect().bottom;
    });
    const names = controls.map(
      (el) =>
        el.dataset["testid"] ??
        el.getAttribute("aria-label") ??
        el.textContent?.trim() ??
        el.tagName,
    );
    const found: string[] = [];
    for (const [i, a] of controls.entries()) {
      const r = a.getBoundingClientRect();
      if (r.right > box.right + 0.5) found.push(`${names[i]} past the bar's end`);
      if (box.left < lights && r.left < lights)
        found.push(`${names[i]} under the window's buttons`);
      for (const [j, b] of controls.entries()) {
        if (j <= i || a.contains(b) || b.contains(a)) continue;
        const s = b.getBoundingClientRect();
        const w = Math.min(r.right, s.right) - Math.max(r.left, s.left);
        const h = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top);
        if (w > 1 && h > 1) found.push(`${names[i]} over ${names[j]}`);
      }
    }
    if (bar.scrollWidth > bar.clientWidth + 1) found.push("the bar spills");
    const header = bar.querySelector("header");
    if (header !== null && header.scrollWidth > header.clientWidth + 1) {
      found.push("the header's controls run past its end");
    }
    return found;
  });

/** Each kind of thread the bar carries, with Conversation only off and on. */
const expectFitsForEach = async (page: Page, threads: readonly string[]) => {
  for (const threadId of threads) {
    await routeTo(page, `/t/${threadId}`);
    await expect(page.getByTestId("shell-titlebar")).toHaveAttribute("data-carries", "thread");
    for (const on of [false, true]) {
      // Folded, the button is inert and out of the accessibility tree: by its test id.
      const toggle = page.getByTestId("shell-titlebar").getByTestId("conversation-only");
      const menu = page.getByTestId("titlebar-overflow");
      // Folded, the switch is View ▸ Conversation only in the "…".
      if ((await toggle.getAttribute("aria-pressed")) !== String(on)) {
        if (await toggle.isVisible()) await toggle.click();
        else {
          await menu.click();
          await page.getByTestId("menu-view").click();
          await page.getByTestId("menu-conversation-only").click();
        }
      }
      await expect
        .poll(() => clashes(page), { message: `${threadId}, Conversation only ${on}` })
        .toEqual([]);
    }
  }
};

for (const width of [1024, 1440]) {
  test(`at ${width} px, nothing in the title bar overlaps with both panes at their limits`, async ({
    page,
  }) => {
    const made = await start(page, width);
    const threads = [made.orchestratorThreadId, made.inReview, "t-flaky"];
    const bar = page.getByTestId("shell-titlebar");

    // The overview as narrow as it goes, the panel as wide: the chat at its least.
    await dragEdge(page, "left-resize", -width);
    await dragEdge(page, "right-resize", -width);
    await expect.poll(async () => (await bar.boundingBox())!.width).toBeLessThanOrEqual(361);
    await expectFitsForEach(page, threads);
    // Folded all the way, Chat · Board are the "…"'s, in words.
    await routeTo(page, `/t/${made.inReview}`);
    await expect(bar).toHaveAttribute("data-fold", "4");
    await page.getByTestId("titlebar-overflow").click();
    await expect(
      page.getByTestId("titlebar-overflow-menu").getByRole("menuitemradio", { name: "Board" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    // The overview hidden: the bar starts after the window's buttons and Show sidebar, and the
    // panel, as wide as it goes, leaves it the room for them.
    await page.keyboard.press("ControlOrMeta+b");
    await expect(page.getByTestId("overview-show")).toBeVisible();
    await dragEdge(page, "right-resize", -width);
    await expectFitsForEach(page, threads);
    // Settings is at the bar's left, or folded from there into the "…".
    await routeTo(page, `/t/${made.inReview}`);
    await expect(bar).toHaveAttribute("data-carries", "thread");
    if ((await bar.getAttribute("data-fold")) === "4") {
      await expect(bar.getByTestId("top-left-nav")).toBeHidden();
      await page.getByTestId("titlebar-overflow").click();
      await expect(page.getByTestId("phone-menu-settings")).toBeVisible();
    } else {
      await expect(bar.getByRole("link", { name: "Settings" })).toBeVisible();
    }
  });
}
