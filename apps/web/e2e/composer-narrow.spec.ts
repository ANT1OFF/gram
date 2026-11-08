import { expect, test, type Locator, type Page } from "@playwright/test";

import { chipFace, choicesChip, choicesPopup, openChoices, pickChoice } from "./composer-choices";
import { seedTheme } from "./seed-theme";

/** An element's right edge; off the scale when it isn't laid out at all. */
const right = async (locator: Locator) => {
  const box = await locator.boundingBox();
  return box === null ? Number.POSITIVE_INFINITY : box.x + box.width;
};

/** Narrows the composer's column the way a narrow grid pane does, without changing the window. */
const squeeze = (page: Page, width: number) =>
  page.locator('[data-surface="composer"]').evaluate((el, w) => {
    el.style.maxWidth = `${w}px`;
  }, width);

/** How far apart the toolbar's controls sit vertically: 0 when they share one row. */
const rowSpread = (page: Page) =>
  page.getByTestId("composer-toolbar").evaluate((el) => {
    const centres = [...el.children]
      .map((child) => child.getBoundingClientRect())
      .filter((box) => box.width > 0)
      .map((box) => box.top + box.height / 2);
    return Math.round(Math.max(...centres) - Math.min(...centres));
  });

// In a narrow pane the toolbar used to clip Stop and Send past the pane's edge; four chips crowded
// Send, then one chip of words folded through shorter words to a row of its own. Now the chip is
// icons with its words on hover (Johan, 2026-11-08): one width at every width, on one row, its name
// always saying every value, and nothing folds into "…".
test("the choices chip stays icons on one row as it narrows, its name every value", async ({
  page,
}) => {
  // Held running, so Stop and Steer stay offered: the script's later approval takes Steer away.
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  await page.goto("/t/t-flaky");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  const message = page.getByLabel("Message", { exact: true });
  const toolbar = page.getByTestId("composer-toolbar");
  // One control for model · effort · mode · speed, in every composer.
  await expect(toolbar.getByTestId("composer-choices")).toHaveCount(1);
  const chip = choicesChip(toolbar);
  await expect(chip).toHaveAccessibleName(
    /^Claude Opus \(.+\) · Effort: Model default \(.+\) · Mode: Ask \(.+\) · Speed: CLI default$/,
  );
  // The agent's mark alone: nothing set matters for safety or cost, and its name says the rest.
  await expect.poll(() => chipFace(chip)).toEqual({ words: "", glyphs: [] });
  await chip.hover();
  const tooltip = page.locator('[data-slot="tooltip-content"]');
  await expect(tooltip).toContainText("Mode: Ask");
  // Opening the popover puts the tooltip away, so the two never sit on top of each other.
  await chip.click();
  await expect(choicesPopup(page)).toBeVisible();
  await expect(tooltip).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(toolbar.getByRole("button", { name: "More composer controls" })).toHaveCount(0);

  // The context gauge beside Send is its bar alone, 32 px, its words in its name.
  const gauge = page.getByTestId("usage-ring");
  await expect(gauge).toHaveText("", { useInnerText: true });
  await expect(gauge).toHaveAccessibleName(/^Context: \d+% of the window used$/);
  expect((await gauge.boundingBox())!.width).toBe(32);

  // Narrower, the chip is the same icons, on the one row with Send and Stop, its name every value.
  const says = async () => {
    await expect.poll(() => chipFace(chip)).toEqual({ words: "", glyphs: [] });
    await expect(chip).toHaveAccessibleName(/ · Mode: Ask \(.+\) · Speed: CLI default$/);
    expect(await rowSpread(page)).toBeLessThanOrEqual(1);
  };
  await squeeze(page, 540);
  await says();
  for (const width of [480, 400, 370, 300, 260]) {
    await squeeze(page, width);
    await says();
  }
  // At 260 px Stop stays inside the composer.
  const edge = await right(message);
  expect(await right(stop)).toBeLessThanOrEqual(edge);

  // With a draft the one button takes Queue, and stays inside the composer however narrow it gets.
  await message.fill("use the fake clock");
  await squeeze(page, 230);
  await expect(toolbar.getByRole("button", { name: "Steer now" })).toHaveCount(0);
  // Once the toolbar has laid itself out for the new width, a frame after the resize.
  const edge230 = await right(message);
  await expect
    .poll(() => right(page.getByRole("button", { name: "Queue", exact: true })))
    .toBeLessThanOrEqual(edge230);
  // Narrow, every section is still there: Speed's says what Fast costs.
  await openChoices(page, toolbar, "speed");
  await expect(choicesPopup(page)).toContainText("separately billed usage credits");
  await pickChoice(page, toolbar, "speed", "Standard");
  await expect(chip).toHaveAccessibleName(/ · Speed: Standard$/);
  await message.fill("");
  await squeeze(page, 260);

  // Each dimension's shortcut opens the popover on its section.
  await message.focus();
  await page.keyboard.press("ControlOrMeta+Shift+KeyA");
  const modes = page.getByRole("listbox", { name: "Mode" });
  await expect(modes).toBeVisible();
  await modes.getByRole("option", { name: "Plan", exact: true }).click();
  await squeeze(page, 720);
  await expect(chip).toHaveAccessibleName(/ · Mode: Plan \(.+\) · /);
  // Plan asks for more, not less: no caution glyph.
  await expect.poll(() => chipFace(chip)).toEqual({ words: "", glyphs: [] });
});

/** Drags the right panel's edge `dx` pixels, negative towards the left. */
async function dragPanel(page: Page, dx: number) {
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

// A 1024 px window with a review beside the chat leaves the composer some 490 px: room for the
// chip's words in full or compact, far from the narrowest. The four chips once took the gauge
// alone for effort here while Mode still said "Ask".
test("beside a review in a 1024 px window, the chip keeps its icons and its name", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/t/t-flaky");
  const shell = page.getByTestId("app-shell");
  // Dragged wide, the review takes Focus review on its own; Esc gives the chat back beside it.
  await dragPanel(page, -400);
  await expect(shell).toHaveAttribute("data-review-focus", "true");
  await page.mouse.move(600, 600);
  await page.keyboard.press("Escape");
  await expect(shell).toHaveAttribute("data-review-focus", "false");
  await expect(page.getByTestId("review-focus")).toHaveAttribute("data-narrow", "true");

  const toolbar = page.getByTestId("composer-toolbar");
  // Its laid-out width, not its box: the chat eases back in from Focus review.
  await expect.poll(() => toolbar.evaluate((el) => el.clientWidth)).toBeGreaterThan(400);
  const chip = choicesChip(toolbar);
  await expect(chip).toHaveAccessibleName(/ · Effort: Model default \(.+\) · Mode: Ask \(.+\) · /);
  await expect.poll(() => chipFace(chip)).toEqual({ words: "", glyphs: [] });
  await expect(toolbar.getByRole("button", { name: "More composer controls" })).toHaveCount(0);
});
test("right-click on Send offers steering and sending into a new draft", async ({ page }) => {
  // Steer disappears when the scripted turn reaches approval; keep the turn running until clicked.
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  await page.goto("/t/t-flaky");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("use the fake clock");
  await page.getByTestId("send-menu-trigger").click({ button: "right" });
  const menu = page.getByTestId("send-menu");
  await expect(menu.getByRole("menuitem", { name: /^Queue/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Send and start a new draft/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Stop", exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: /^Steer now/ }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
});

// The transcript fades into the composer over its last 24 px; following the newest message has to
// stop short of that fade, or the reply's last line sits under it.
test("the newest message is followed clear of the fade into the composer", async ({ page }) => {
  // Short enough that the transcript scrolls, so following it is what places the last row. With one
  // bar above the pane, the README's rows overflow a window this tall by some 50 px.
  await page.setViewportSize({ width: 1200, height: 480 });
  await page.goto("/t/t-docs");
  const transcript = page.getByTestId("transcript");
  // The script's README is the newest message from its first words, and is followed as it grows:
  // the row checked is that one, not whichever the virtualizer happens to have mounted last.
  const newest = transcript
    .locator("[data-index]")
    .filter({ hasText: "Gram runs your coding agents" });
  // The README starts about 2 s after the page loads, and only overflows the transcript some 3 s
  // into its stream, so the check below starts from its first words rather than from the load.
  await expect(newest).toHaveCount(1);
  await expect
    .poll(() =>
      newest.evaluate((row) => {
        const el = row.closest<HTMLElement>('[data-testid="transcript"]')!;
        const indices = [...el.querySelectorAll<HTMLElement>("[data-index]")].map((r) =>
          Number(r.dataset.index),
        );
        return {
          scrolls: el.scrollHeight > el.clientHeight,
          atEnd: el.scrollHeight - el.clientHeight - el.scrollTop <= 1,
          isLast: Number(row.dataset.index) === Math.max(...indices),
          clear:
            Math.round(el.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom) >=
            24,
        };
      }),
    )
    .toEqual({ scrolls: true, atEnd: true, isLast: true, clear: true });
});

// Stop and Queue stay quiet while the agent works; the border says it instead, and Steer shows only
// once there is something to steer in.
test("a running turn lights the border, and Steer waits for a draft", async ({ page }) => {
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  await seedTheme(page, { palette: "tokyo-night", mode: "dark", motion: "system" });
  await page.goto("/t/t-flaky");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  const message = page.getByLabel("Message", { exact: true });
  await message.focus();

  const light = page.getByTestId("running-edge").locator(".gram-running-light");
  const first = await light.evaluate((el) => el.style.translate);
  await expect.poll(() => light.evaluate((el) => el.style.translate)).not.toBe(first);

  await message.fill("use the fake clock");
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();
  await expect(stop).toBeHidden();
  await message.fill("");

  await stop.click();
  // The mock notices an interrupt only between steps, so the held gate has to open for it to stop.
  await page.evaluate(() => window.gramMock?.release("flaky-read"));
  await expect(stop).toBeHidden();
  await expect(page.getByTestId("running-edge")).toHaveCount(0);
});

test("one send button: Stop while empty, Queue with a draft, Steer with the modifier", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  await page.goto("/t/t-flaky");
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  await expect(button("Stop")).toBeVisible();
  await button("Stop").hover();
  // Its word and its shortcut: ⌘. on macOS and Ctrl+. elsewhere.
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(/^Stop \((⌘|Ctrl\+)\.\)$/);

  const message = page.getByLabel("Message", { exact: true });
  await message.fill("use the fake clock");
  await expect(button("Queue")).toBeVisible();
  await expect(button("Stop")).toHaveCount(0);

  await page.keyboard.down("Meta");
  await expect(button("Steer now")).toBeVisible();
  await button("Steer now").click({ modifiers: ["Meta"] });
  await page.keyboard.up("Meta");
  await expect(message).toHaveValue("");
  await expect(button("Stop")).toBeVisible();
});
