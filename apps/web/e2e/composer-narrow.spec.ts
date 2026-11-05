import { expect, test, type Locator, type Page } from "@playwright/test";

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

// In a narrow pane the toolbar used to clip Stop and Send past the pane's edge, and later dropped
// every value for a glyph. Now each value goes compact first ("Opus"), then the pickers take a row
// of their own with their words, and only at the narrowest do glyphs and "…" stand in.
test("the toolbar keeps its values as it narrows, before glyphs and …", async ({ page }) => {
  // Held running, so Stop and Steer stay offered: the script's later approval takes Steer away.
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  await page.goto("/t/t-flaky");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  const message = page.getByLabel("Message", { exact: true });
  const toolbar = page.getByTestId("composer-toolbar");
  // One order, in every composer: model · effort · mode · speed.
  await expect(toolbar.locator("[data-toolbar-block]")).toHaveCount(4);
  expect(
    await toolbar
      .locator("[data-toolbar-block]")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset["toolbarBlock"])),
  ).toEqual(["model", "effort", "mode", "speed"]);
  // With room, Mode says its value beside the glyph; its name and tooltip say it too, and the open
  // list spells out every mode.
  const mode = toolbar.getByRole("combobox", { name: /^Mode: / });
  await expect(mode).toHaveAccessibleName("Mode: Ask");
  await expect(mode.locator("[data-toolbar-label]")).not.toHaveClass(/\bsr-only\b/);
  await expect(mode).toHaveText(/^Ask/);
  await mode.hover();
  const tooltip = page.locator('[data-slot="tooltip-content"]');
  await expect(tooltip).toHaveText(/^Mode: Ask/);
  // Opening the list puts the tooltip away, so the two never sit on top of each other.
  await mode.click();
  await expect(page.getByRole("option", { name: "Bypass", exact: true })).toBeVisible();
  await expect(tooltip).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Speed at the CLI's default keeps its slot, named with its value (its word shows when the row
  // has room, and is the first to go short of it); nothing waits in "…".
  const more = toolbar.getByRole("button", { name: "More composer controls" });
  const speed = toolbar.getByRole("combobox", { name: /^Speed/ });
  await expect(speed).toBeVisible();
  await expect(speed).toHaveAccessibleName("Speed: CLI default");
  await expect(more).toHaveCount(0);

  // The context gauge beside Send keeps the ring's 32 px: the steps below are measured against
  // what that slot leaves, and a wider gauge folded the pickers a step early.
  const gauge = await page.getByTestId("usage-ring").boundingBox();
  expect(gauge!.width).toBeLessThanOrEqual(32);

  // Short of room, the model's name goes compact first; the others keep their words.
  const model = toolbar.getByRole("combobox", { name: /^Model/ });
  await squeeze(page, 520);
  const compact = model.locator("[data-toolbar-compact]");
  await expect(compact).not.toHaveClass(/\bsr-only\b/);
  await expect(compact).toHaveText("Opus");
  await expect(model.locator("[data-toolbar-label]")).toHaveClass(/\bsr-only\b/);
  await expect(model).toHaveAccessibleName("Model: Claude Opus");
  await expect(mode).toHaveText(/^Ask/);
  expect(await rowSpread(page)).toBeLessThanOrEqual(1);

  // Narrower, the pickers take a row of their own, words and all, above Send and Stop: still so
  // at 300 px, a narrow pane beside a wide diff in a 1024 px window.
  await squeeze(page, 300);
  await expect(toolbar).toHaveAttribute("data-wrapped", "true");
  await expect(mode).toHaveText(/^Ask/);
  const modeBox = await mode.boundingBox();
  const stopBox = await stop.boundingBox();
  expect(stopBox!.y).toBeGreaterThanOrEqual(modeBox!.y + modeBox!.height);

  // Only at the narrowest do glyphs stand in, on one row, and the pickers fold into "…". Effort's
  // default, like Speed's, gives up its word first, so the words hold on to 270 px.
  await squeeze(page, 260);
  await expect(toolbar).not.toHaveAttribute("data-wrapped");
  await expect(mode).toHaveCount(0);
  await expect(more).toBeVisible();
  expect(await rowSpread(page)).toBeLessThanOrEqual(1);
  const edge = await right(message);
  expect(await right(stop)).toBeLessThanOrEqual(edge);

  // With a draft the one button takes Queue, and stays inside the composer however narrow it gets.
  await message.fill("use the fake clock");
  await squeeze(page, 230);
  await expect(toolbar.getByRole("button", { name: "Steer now" })).toHaveCount(0);
  // Once the toolbar has laid itself out for the new width, a frame after the resize: at 260 px
  // the draft's narrower Queue let every picker back as a glyph, and 230 px folds them again.
  const edge230 = await right(message);
  await expect
    .poll(() => right(page.getByRole("button", { name: "Queue", exact: true })))
    .toBeLessThanOrEqual(edge230);
  await more.click();
  await page
    .getByTestId("composer-overflow-menu")
    .getByRole("menuitem", { name: /^Speed/ })
    .click();
  // The submenu is named by its own aria-label; Base UI 1.9 prefers that to the trigger's text.
  const speedMenu = page.getByRole("menu", { name: "Speed", exact: true });
  await expect(speedMenu).toContainText("separately billed usage credits");
  await speedMenu.getByRole("menuitemradio", { name: "Standard", exact: true }).click();
  await page.keyboard.press("Escape");
  await message.fill("");
  await squeeze(page, 260);

  // A folded picker is a submenu of "…", and its shortcut opens it there.
  await message.focus();
  await page.keyboard.press("ControlOrMeta+Shift+KeyA");
  const menu = page.getByTestId("composer-overflow-menu");
  await expect(menu).toBeVisible();
  await page
    .getByRole("menu", { name: "Mode" })
    .getByRole("menuitemradio", { name: "Plan" })
    .click();
  await squeeze(page, 720);
  await expect(mode).toHaveAccessibleName("Mode: Plan");
  await expect(toolbar.getByRole("combobox", { name: "Speed: Standard" })).toBeVisible();
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

/** The words a toolbar picker shows beside its glyph: "" when the glyph stands alone. */
const shownWords = (picker: Locator) =>
  picker.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>("[data-toolbar-label], [data-toolbar-compact]")]
      .filter((words) => !words.classList.contains("sr-only") && words.offsetWidth > 0)
      .map((words) => words.textContent ?? "")
      .join("")
      .trim(),
  );

// A 1024 px window with a review beside the chat leaves the composer some 490 px: short of room
// for every value in full, but far from the 280 px where glyphs take over. Effort's default used to
// have no short word, so there it went to its gauge alone while Mode still said "Ask".
test("beside a review in a 1024 px window, effort keeps a short word", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/t/t-flaky");
  const shell = page.getByTestId("app-shell");
  // Dragged wide, the review takes Focus review on its own; Esc gives the chat back beside it.
  await dragPanel(page, -400);
  await expect(shell).toHaveAttribute("data-review-focus", "true");
  await page.mouse.move(600, 600);
  await page.keyboard.press("Escape");
  await expect(shell).toHaveAttribute("data-review-focus", "false");
  await expect(page.getByTestId("review-room-offer")).toBeVisible();

  const toolbar = page.getByTestId("composer-toolbar");
  // Its laid-out width, not its box: the chat eases back in from Focus review.
  await expect.poll(() => toolbar.evaluate((el) => el.clientWidth)).toBeGreaterThan(400);
  const effort = toolbar.getByRole("combobox", { name: /^Effort: / });
  await expect(effort).toHaveAccessibleName("Effort: Model default");
  const mode = toolbar.getByRole("combobox", { name: /^Mode: / });
  await expect(mode).toHaveText(/^Ask/);
  // A readable value of three letters or more, the compact one or the whole: never the gauge alone.
  await expect.poll(() => shownWords(effort)).toMatch(/^(Model|Model default)$/);
  await expect
    .poll(() => shownWords(toolbar.getByRole("combobox", { name: /^Model/ })))
    .toMatch(/^(Opus|Claude Opus)$/);
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
  // Its word, that what the turn wrote stays, and its shortcut: ⌘. on macOS and Ctrl+. elsewhere.
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
    /^Stop · keeps the reply so far \((⌘|Ctrl\+)\.\)$/,
  );

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
