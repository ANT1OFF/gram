import { expect, test, type Page } from "@playwright/test";

import { openOverviewDensity } from "./overview-density";
import { seedTheme } from "./seed-theme";
import { openOrchestrator, threadRow } from "./thread-row";

async function resizePane(page: Page, width: number) {
  const handle = page.getByRole("separator", { name: "Resize overview" });
  const box = (await handle.boundingBox())!;
  const current = Number(await handle.getAttribute("aria-valuenow"));
  const y = Math.max(0, box.y) + 80;
  expect(
    await page.evaluate(
      ({ x, atY }) => document.elementFromPoint(x, atY)?.getAttribute("aria-label"),
      { x: box.x + box.width / 2, atY: y },
    ),
  ).toBe("Resize overview");
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + width - current, y, { steps: 8 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", String(width));
}

for (const mode of ["light", "dark"] as const) {
  test(`workspace names, workers and keyboard details survive overview resizing in ${mode}`, async ({
    page,
  }) => {
    await seedTheme(page, { palette: "minimal-ocean", mode, motion: "off" });
    await page.clock.setFixedTime(new Date("2026-06-15T08:00:00Z"));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const made = await openOverviewDensity(page, 180);
    // On the board's workspace, its features open with their live workers.
    await openOrchestrator(page, made.orchestratorThreadId);
    const sidebar = page.getByTestId("overview-sidebar");
    const working = threadRow(page, made.working);
    const resting = threadRow(page, made.briefed);
    const asking = threadRow(page, made.waiting[0]);
    const failingPr = sidebar.locator(
      `[data-testid="overview-pr-chips"][data-thread-id="${made.working}"] [data-pr="214"]`,
    );
    await expect(working).toBeVisible();
    const ids = () =>
      sidebar
        .getByTestId("overview-worker")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-thread-id")));
    const order = await ids();
    const samples: unknown[] = [];

    for (const width of [180, 280, 380, 280, 180]) {
      await resizePane(page, width);
      // At work while its PR fails CI: neither fact replaces the other.
      await expect(working.getByTestId("overview-worker-step")).toBeVisible();
      await expect(failingPr.locator('[data-checks="failing"]')).toBeVisible();
      await expect(resting.getByTestId("overview-worker-step")).toHaveCount(0);
      await expect(working.getByTestId("overview-worker-title")).toHaveText(
        "Improve workspace navigation and preserve approval boundaries",
      );
      await expect(asking).toHaveAttribute("data-asking", "true");
      expect(await ids()).toEqual(order);
      const geometry = await sidebar.evaluate((element) => {
        const right = element.getBoundingClientRect().right;
        const leaves = [
          ...element.querySelectorAll<HTMLElement>(
            '[data-testid="overview-workspace-row"], [data-testid="overview-workspace-fold"], [data-testid="overview-worker-title"], [data-testid="overview-worker-now"], [data-testid="overview-stage"], [data-testid="overview-solo"]',
          ),
        ];
        return leaves.map((leaf) => ({
          id: leaf.dataset.testid,
          width: leaf.getBoundingClientRect().width,
          height: leaf.getBoundingClientRect().height,
          overflow: leaf.getBoundingClientRect().right - right,
        }));
      });
      expect(geometry.every((leaf) => leaf.overflow <= 1)).toBe(true);
      expect(
        geometry
          .filter((leaf) => leaf.id === "overview-worker-title")
          .every((leaf) => leaf.width >= 30),
      ).toBe(true);
      samples.push({ width, geometry });
      await sidebar.screenshot({ path: test.info().outputPath(`${mode}-${width}.png`) });
    }

    // Crossing widths keeps the focused worker attached to its existing DOM node.
    await resting.focus();
    await resting.evaluate((element) => {
      element.dataset.resizeWitness = "same-row";
    });
    for (const width of [338, 344, 338, 380]) {
      await resizePane(page, width);
      await expect(resting).toHaveAttribute("data-resize-witness", "same-row");
    }
    await resting.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await expect(resting).toBeFocused();
    await working.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menuitem", { name: "More…", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.evaluate(
      (threadId) => window.gramMock!.simulateStatus(threadId, "error", "Synthetic worker failure"),
      made.working,
    );
    await expect(working.getByTestId("overview-worker-step")).toHaveCount(0);
    expect(errors).toEqual([]);
    await test.info().attach("pane-geometry", {
      body: JSON.stringify(samples, null, 2),
      contentType: "application/json",
    });
  });
}
