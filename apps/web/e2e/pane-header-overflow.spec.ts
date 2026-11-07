import { expect, test } from "@playwright/test";
import { openPanelTab } from "./panel-tab";

// With the overview's 60 px rail (the overview under 1280 px) and the right panel open, an 880 px
// window leaves the pane about 470 px. The header used to run past the pane, and the right panel
// covered its Thread menu. A thread's header is the title bar's now, sharing it with the window's
// controls: at 880 px it is too narrow for every chip, so chips wrap out of sight; at 1440 px, with
// the full overview and the panel, the calmer bar leaves them all room.
for (const width of [880, 1440]) {
  test(`the pane header stays inside the pane, so the right panel never covers its menu (${width} px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/t/t-flaky");
    const panel = page.getByTestId("right-panel");
    await openPanelTab(panel, "PR");
    await expect(panel.getByTestId("pr-panel")).toBeVisible();
    await page.evaluate(() => window.gramMock?.simulateUnpushed("t-flaky" as never, 2));
    await expect(panel.getByTestId("pr-panel-push").getByRole("button")).toBeVisible();
    // Hidden from the PR strip, the PR's chips are the header's, and there are too many to fit.
    await page
      .getByTestId("pr-row")
      .getByRole("button", { name: /^Hide #412 / })
      .click();
    await expect(page.getByTestId("pr-row")).toHaveCount(0);
    // Measured beside the Files tab's 352 px: a review opens wider, leaving the chat 800 px, and
    // the title bar then folds chips out of sight sooner (review-width.spec.ts).
    await openPanelTab(panel, "Files");
    // The shell's columns ease to the new width: measure once they've settled.
    await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0)).toBe(352);

    const header = page.getByTestId("pane-header").first();
    const overflow = await header.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, "header content wider than the header").toBeLessThanOrEqual(0);

    // The chips that wrapped out of sight are out of the Tab order too, so focus can't scroll the
    // row off its first line.
    const chips = header.getByTestId("pane-header-chips");
    const measure = () =>
      chips.evaluate((row) => {
        const top = row.getBoundingClientRect().top;
        return [...row.children].map((child) => ({
          wrapped: child.getBoundingClientRect().top - top >= row.clientHeight,
          inert: (child as HTMLElement).inert,
        }));
      });
    await expect
      .poll(
        async () => (await measure()).some((r) => r.wrapped),
        width === 880
          ? { message: "a chip wrapped at this width" }
          : { message: "every chip fits at this width" },
      )
      .toBe(width === 880);
    const rows = await measure();
    expect(rows.every((r) => r.wrapped === r.inert)).toBe(true);
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    expect(await chips.evaluate((row) => row.scrollTop)).toBe(0);

    // The thread's menu is the title bar's one "…".
    const menu = page.getByTestId("shell-titlebar").getByTestId("titlebar-overflow");
    const main = await page.locator("main").boundingBox();
    const box = await menu.boundingBox();
    expect(main && box).toBeTruthy();
    expect(box!.x + box!.width).toBeLessThanOrEqual(main!.x + main!.width);

    // Playwright's actionability check fails when another element would receive the click.
    await menu.click({ trial: true, timeout: 2000 });
    await menu.click();
    // The push is the branch's, which More… has.
    await page.getByTestId("menu-thread").click();
    await page.getByTestId("titlebar-menu-thread").getByRole("menuitem", { name: "More…" }).click();
    await expect(
      page.getByTestId("command-palette").getByRole("option", { name: "Push 2 commits" }),
    ).toBeVisible();
  });
}
