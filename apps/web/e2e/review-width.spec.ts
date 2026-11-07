import { expect, test, type Locator, type Page } from "@playwright/test";

import { openPanelTab } from "./panel-tab";

const widthOf = async (locator: Locator) => Math.round((await locator.boundingBox())?.width ?? 0);

const tab = (page: Page, name: string) =>
  page.getByTestId("right-panel").getByRole("tab", { name, exact: true });

/** Drags the right panel's edge `dx` pixels, negative towards the left. */
async function dragHandle(page: Page, dx: number) {
  const handle = page.getByRole("separator", { name: "Resize right panel" });
  await expect.poll(async () => JSON.stringify(await handle.boundingBox())).not.toBe("null");
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

test("the Diff and PR tabs open wide, keep their own width, and give it back for other tabs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2400, height: 900 });
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await expect(tab(page, "Diff")).toHaveAttribute("aria-selected", "true");
  // 55% of the window, beside the 248 px overview.
  await expect.poll(() => widthOf(panel)).toBe(1320);
  // In a narrower window, as far as it leaves the chat 800 px.
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect.poll(() => widthOf(panel)).toBe(1600 - 248 - 800);
  await page.setViewportSize({ width: 2400, height: 900 });

  await openPanelTab(page.getByTestId("right-panel"), "Files");
  await expect.poll(() => widthOf(panel)).toBe(352);
  await openPanelTab(page.getByTestId("right-panel"), "PR");
  await expect.poll(() => widthOf(panel)).toBe(1320);

  // A drag on a review is the review's; the other tabs keep theirs.
  await dragHandle(page, 100);
  await expect.poll(() => widthOf(panel)).toBe(1220);
  await openPanelTab(page.getByTestId("right-panel"), "Terminal");
  await expect.poll(() => widthOf(panel)).toBe(352);
  await openPanelTab(page.getByTestId("right-panel"), "Diff");
  await expect.poll(() => widthOf(panel)).toBe(1220);

  // Remembered across a reload.
  await page.reload();
  await expect.poll(() => widthOf(page.getByTestId("right-panel"))).toBe(1220);
});

test("Focus review takes the window but for a strip of the chat, and Esc gives it back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  const shell = page.getByTestId("app-shell");
  const panel = page.getByTestId("right-panel");
  const chat = page.locator("main");
  await expect.poll(() => widthOf(panel)).toBe(1440 - 248 - 800);
  const chatWidth = await widthOf(chat);

  await panel.getByRole("button", { name: "Focus review" }).click();
  await expect(shell).toHaveAttribute("data-review-focus", "true");
  await expect.poll(() => widthOf(panel)).toBe(1440 - 300);
  await expect(page.getByTestId("overview-sidebar")).toHaveCount(0);
  await expect(chat).toHaveAttribute("inert");
  // The transcript stays mounted at its width under the panel, so it isn't laid out anew.
  await expect(page.getByTestId("thread-view")).toHaveCount(1);
  expect(await widthOf(chat)).toBe(chatWidth);
  // The strip keeps the conversation readable: its title and its latest message.
  const strip = page.getByTestId("review-strip");
  await expect(strip).toBeVisible();
  await expect(strip).toHaveAttribute("data-readable", "true");
  await expect(strip.getByTestId("review-strip-title")).toHaveText("Fix flaky retry test");
  await expect(strip.getByTestId("review-strip-latest")).not.toBeEmpty();

  await page.mouse.move(700, 600);
  await page.keyboard.press("Escape");
  await expect(shell).toHaveAttribute("data-review-focus", "false");
  await expect.poll(() => widthOf(panel)).toBe(1440 - 248 - 800);
  await expect(chat).not.toHaveAttribute("inert");
  await expect(page.getByTestId("overview-sidebar")).toBeVisible();

  // The shortcut does both, from another tab too, and the strip's button comes back.
  await openPanelTab(page.getByTestId("right-panel"), "Files");
  await page.locator("body").click({ position: { x: 700, y: 300 } });
  await page.keyboard.press("ControlOrMeta+Alt+KeyF");
  await expect(shell).toHaveAttribute("data-review-focus", "true");
  await expect(tab(page, "Diff")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ControlOrMeta+Alt+KeyF");
  await expect(shell).toHaveAttribute("data-review-focus", "false");
  await page.keyboard.press("ControlOrMeta+Alt+KeyF");
  await strip.getByRole("button", { name: "Back to the conversation" }).click();
  await expect(shell).toHaveAttribute("data-review-focus", "false");

  // Another tab leaves focus: only a review takes the window.
  await panel.getByRole("button", { name: "Focus review" }).click();
  await expect(shell).toHaveAttribute("data-review-focus", "true");
  await openPanelTab(page.getByTestId("right-panel"), "Terminal");
  await expect(shell).toHaveAttribute("data-review-focus", "false");
  await expect.poll(() => widthOf(panel)).toBe(352);

  // In focus, the action beside the tabs says Restore, and gives the chat back too.
  await openPanelTab(page.getByTestId("right-panel"), "Diff");
  await panel.getByRole("button", { name: "Focus review" }).click();
  await expect(shell).toHaveAttribute("data-review-focus", "true");
  const restore = panel.getByRole("button", { name: "Restore", exact: true });
  await expect(restore).toContainText("Restore");
  await restore.click();
  await expect(shell).toHaveAttribute("data-review-focus", "false");
  await expect(panel.getByRole("button", { name: "Focus review" })).toBeVisible();
});

test("beside a review the chat keeps its room, and a review held too narrow takes Focus review", async ({
  page,
}) => {
  // 1024 wide: the overview is its compact rail, 60 px.
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/t/t-flaky");
  const shell = page.getByTestId("app-shell");
  const panel = page.getByTestId("right-panel");
  const chat = page.locator("main");
  await expect(tab(page, "Diff")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => widthOf(panel)).toBe(352);
  // Narrower than a review reads, it offers Focus review in words beside its tabs, with no notice
  // row of its own under them.
  const offer = panel.getByTestId("review-focus");
  await expect(offer).toHaveAttribute("data-narrow", "true");
  await expect(panel.getByTestId("review-room-offer")).toHaveCount(0);
  await expect(shell).toHaveAttribute("data-review-focus", "false");

  // Dragged wide, the review stops where the chat keeps 520 px, too narrow to read: it takes the
  // window on its own, and leaves the chat its strip.
  await dragHandle(page, -400);
  await expect(shell).toHaveAttribute("data-review-focus", "true");
  await expect.poll(() => widthOf(panel)).toBe(1024 - 300);

  // Esc gives the chat back, side by side as the user chose: the review says why it is cramped and
  // offers focus again, and isn't taken again on its own.
  await page.mouse.move(600, 600);
  await page.keyboard.press("Escape");
  await expect(shell).toHaveAttribute("data-review-focus", "false");
  await expect.poll(() => widthOf(chat)).toBe(520);
  await expect.poll(() => widthOf(panel)).toBe(1024 - 60 - 520);
  await expect(offer).toHaveAttribute("data-narrow", "true");
  await expect(shell).toHaveAttribute("data-review-focus", "false");

  // With room again and then short once more, it takes focus on its own again.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(shell).toHaveAttribute("data-review-focus", "false");
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(shell).toHaveAttribute("data-review-focus", "true");
});

test("Split, Wrap lines and Hide whitespace changes sit in the review toolbar and are remembered", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  const diff = page.getByTestId("diff-panel");
  const clock = diff.locator('[data-testid="diff-file"][data-path="src/clock.ts"]');
  await clock.locator("[data-diff-file-header]").click();
  await expect(clock.locator('tr[data-kind="add"]')).toHaveCount(2);
  // Lines wrap until the user says otherwise.
  await expect(clock.getByTestId("patch")).toHaveAttribute("data-wrap", "true");

  // Each choice is a toggle in the toolbar, not behind a menu.
  const wrap = diff.getByRole("button", { name: "Wrap lines" });
  const ignore = diff.getByRole("button", { name: "Hide whitespace changes" });
  await expect(wrap).toHaveAttribute("aria-pressed", "true");
  await wrap.click();
  await expect(wrap).toHaveAttribute("aria-pressed", "false");
  await expect(clock.getByTestId("patch")).toHaveAttribute("data-wrap", "false");
  await ignore.click();
  await expect(ignore).toHaveAttribute("aria-pressed", "true");
  // The re-indented line is context now.
  await expect(clock.locator('tr[data-kind="add"]')).toHaveCount(1);
  await expect(clock.locator('tr[data-kind="del"]')).toHaveCount(1);
  await expect(diff.getByRole("radio", { name: "Unified" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await page.reload();
  const again = page.getByTestId("diff-panel");
  await expect(again.getByRole("button", { name: "Wrap lines" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(again.getByRole("button", { name: "Hide whitespace changes" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const reloaded = again.locator('[data-testid="diff-file"][data-path="src/clock.ts"]');
  await reloaded.locator("[data-diff-file-header]").click();
  await expect(reloaded.locator('tr[data-kind="add"]')).toHaveCount(1);
  await expect(reloaded.getByTestId("patch")).toHaveAttribute("data-wrap", "false");
});
