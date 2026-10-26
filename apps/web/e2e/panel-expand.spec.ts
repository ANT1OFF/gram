import { expect, test, type Locator, type Page } from "@playwright/test";

import { slowdown } from "./slowdown";
import { setLayout } from "./layout";
import { threadRow } from "./thread-row";

type Box = NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>;

const widthOf = async (locator: Locator) => (await locator.boundingBox())?.width ?? 0;

/**
 * Where `locator` is once two reads a poll apart agree. Visible isn't settled: a panel sliding back
 * in shows its edge on the way, and a drag begun there measures the slide as well as the drag.
 */
async function settledBox(locator: Locator) {
  let last: Box | null = null;
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      const still = box !== null && JSON.stringify(box) === JSON.stringify(last);
      last = box;
      return still;
    })
    .toBe(true);
  return last!;
}

/** Drags the right panel's edge `dx` pixels, negative towards the left. */
async function dragHandle(page: Page, dx: number) {
  const box = await settledBox(page.getByRole("separator", { name: "Resize right panel" }));
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

/** Restore from the panel edge, with no tooltip owning Escape. Tooltip Escape is a separate interaction. */
async function restorePanelWithEscape(page: Page) {
  await page.mouse.move(0, 0);
  await page.getByRole("separator", { name: "Resize right panel" }).focus();
  await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveCount(0);
  await page.keyboard.press("Escape");
}

test("the right panel widens past 960 px, expands over the chat and fits a narrow window with the overview open", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto("/t/t-deps");
  const shell = page.getByTestId("app-shell");
  const panel = page.getByTestId("right-panel");
  const chat = page.locator("main");
  await expect(panel).toBeVisible();
  // This scenario keeps the full overview beside the chat, including in narrow windows.
  // Automatic mode instead becomes a 60 px rail below 1280 px.
  await page.getByRole("button", { name: "Compact overview", exact: true }).click();
  await page.getByRole("button", { name: "Expand overview", exact: true }).click();
  await expect.poll(() => widthOf(page.getByTestId("overview-sidebar"))).toBe(280);

  await dragHandle(page, -700);
  await expect.poll(() => widthOf(panel)).toBeGreaterThan(960);
  // Dragged as far as it goes, the chat keeps its minimum.
  await dragHandle(page, -1500);
  await expect.poll(() => widthOf(chat)).toBe(360);
  const dragged = await widthOf(panel);

  await page.getByRole("button", { name: "Expand panel" }).click();
  await expect(shell).toHaveAttribute("data-panel-expanded", "true");
  await expect(chat).toHaveAttribute("inert");
  await expect.poll(() => widthOf(panel)).toBe(1920 - 280);
  // The chat is behind the panel, not unmounted.
  await expect(page.getByTestId("thread-view")).toHaveCount(1);

  await restorePanelWithEscape(page);
  await expect(shell).toHaveAttribute("data-panel-expanded", "false");
  await expect(chat).not.toHaveAttribute("inert");
  await expect.poll(() => widthOf(panel)).toBe(dragged);

  const handle = page.getByRole("separator", { name: "Resize right panel" });
  await handle.dblclick();
  await expect(shell).toHaveAttribute("data-panel-expanded", "true");
  await page.getByRole("button", { name: "Restore panel width" }).click();
  await expect(shell).toHaveAttribute("data-panel-expanded", "false");

  // A narrow window shows less of the stored width, and gives it back when it widens again.
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect.poll(() => widthOf(panel)).toBe(1000 - 280 - 360);
  await expect.poll(() => widthOf(chat)).toBe(360);
  // Expanded, the chat keeps its 360 px underneath, and nothing of it shows through the panel.
  await page.getByRole("button", { name: "Expand panel" }).click();
  await expect.poll(() => widthOf(panel)).toBe(1000 - 280);
  const onTop = await page.evaluate(() =>
    [300, 500, 640].every((x) =>
      [100, 400, 680].every((y) =>
        document
          .querySelector("[data-testid='right-panel']")!
          .contains(document.elementFromPoint(x, y)),
      ),
    ),
  );
  expect(onTop).toBe(true);
  await restorePanelWithEscape(page);
  // Narrower still, the sidebar gives way too, and the chat keeps its minimum.
  await page.setViewportSize({ width: 800, height: 700 });
  await expect.poll(() => widthOf(chat)).toBe(360);
  await expect.poll(() => widthOf(panel)).toBe(240);
  // With no room for both, the panel steps aside, and its toggle opens it over the chat.
  await page.setViewportSize({ width: 640, height: 700 });
  await expect(panel).toHaveCount(0);
  await expect.poll(() => widthOf(chat)).toBe(640 - 280);
  const toggle = page.getByRole("button", { name: "Show right panel" });
  await toggle.click();
  await expect(shell).toHaveAttribute("data-panel-expanded", "true");
  await restorePanelWithEscape(page);
  await expect(panel).toHaveCount(0);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await expect.poll(() => widthOf(panel)).toBe(dragged);
});

test("keys reach the expanded panel, not the approval hidden behind it", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 20_000 * slowdown });
  await page.getByRole("button", { name: "Expand panel" }).click();
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-panel-expanded", "true");
  // Enter on the edge, which isn't a button, mustn't reach the hidden card's Allow either.
  await page.getByRole("separator", { name: "Resize right panel" }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-panel-expanded", "false");
  // An answered card folds away once the answer lands; give it the time to.
  await page.waitForTimeout(1000 * slowdown);
  await expect(card).toBeVisible();
  await expect(card.getByTestId("approval-deny")).toBeEnabled();
});

test("expanding works in a grid and with the panel on the left", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/t/t-deps");
  const shell = page.getByTestId("app-shell");
  const panel = page.getByTestId("right-panel");

  await setLayout(page, "2 columns");
  await expect(page.getByTestId("pane")).toHaveCount(2);
  await page.getByRole("button", { name: "Expand panel" }).click();
  await expect.poll(() => widthOf(panel)).toBe(1600 - 280);
  await restorePanelWithEscape(page);
  await expect(shell).toHaveAttribute("data-panel-expanded", "false");
  await expect(page.getByTestId("pane")).toHaveCount(2);
  await setLayout(page, "1 pane");

  await page.goto("/settings/general");
  await page
    .getByTestId("general-settings")
    .getByRole("radio", { name: "Left", exact: true })
    .click();
  await expect(shell).toHaveAttribute("data-panel-side", "left");
  await threadRow(page, "t-deps").click();
  await expect(panel).toBeVisible();
  // Settings had no use for the panel, so it slides back in.
  await expect.poll(() => widthOf(panel)).toBe(352);

  await dragHandle(page, 300);
  await expect.poll(() => widthOf(panel)).toBe(352 + 300);
  await page.getByRole("button", { name: "Expand panel" }).click();
  await expect.poll(async () => (await panel.boundingBox())?.x).toBe(280);
  await expect.poll(() => widthOf(panel)).toBe(1600 - 280);
  // Opening settings brings the chat's place back, so it isn't hidden behind the panel.
  await page.keyboard.press("ControlOrMeta+Comma");
  await expect(shell).toHaveAttribute("data-panel-expanded", "false");
});
