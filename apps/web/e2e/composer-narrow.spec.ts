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

// In a narrow pane the toolbar used to clip Stop and Send past the pane's edge, later dropped every
// value for a glyph, and then kept a bare "Effort" and "Speed". Now each goes compact first
// ("Opus", "Effort: Default"), then to its value beside its glyph ("Default"), then the pickers take
// a row of their own, and only at the narrowest do glyphs and "…" stand in.
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
  // Its words name what it picks, so a value never reads as another control's.
  await expect(mode).toHaveText(/^Mode: Ask/);
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

  // With room the context gauge beside Send says what it measures, "Context 31%".
  const gauge = page.getByTestId("usage-ring");
  await expect(gauge).toHaveText(/^Context \d+%$/, { useInnerText: true });

  // Short of room, each picker gives up its chevron, then its dimension's word, from the right,
  // and keeps its value beside its glyph: one row while the values fit, never a dimension alone
  // ("Effort", "Speed": the narrow composer used to say just that). Linux names Stop's key
  // "Ctrl+.", some 26 px wider than "⌘.", so the exact step at a width differs by platform; what
  // holds everywhere is that every picker says its value.
  const model = toolbar.getByRole("combobox", { name: /^Model/ });
  const effort = toolbar.getByRole("combobox", { name: /^Effort: / });
  const says = async () => {
    await expect.poll(() => shownWords(effort)).toMatch(/^(Effort: )?Default$/);
    await expect.poll(() => shownWords(mode)).toMatch(/^(Mode: )?Ask$/);
    await expect.poll(() => shownWords(speed)).toMatch(/^(Speed: )?Default$/);
    await expect.poll(() => shownWords(model)).toMatch(/^(Claude )?Opus$/);
  };
  // One row, or wrapped onto a row of their own above Send and Stop: never under or beside them.
  const placed = async () => {
    if ((await toolbar.getAttribute("data-wrapped")) === "true") {
      const modeBox = await mode.boundingBox();
      const stopBox = await stop.boundingBox();
      expect(stopBox!.y).toBeGreaterThanOrEqual(modeBox!.y + modeBox!.height);
    } else {
      expect(await rowSpread(page)).toBeLessThanOrEqual(1);
    }
  };
  await squeeze(page, 540);
  await says();
  await placed();
  await expect(model).toHaveAccessibleName(/^Model(: Claude Opus)?$/);
  // Under 36 rem the gauge keeps the ring's 32 px, its number alone: the steps below are measured
  // against what that slot leaves, and a wider gauge folded the pickers a step early.
  await expect(gauge).toHaveText(/^\d+%$/, { useInnerText: true });
  expect((await gauge.boundingBox())!.width).toBeLessThanOrEqual(32);

  // Narrower, values alone beside their glyphs, on one row or, short of that, on a row of their
  // own above Send and Stop: still every value at 370 px. (The bare "Effort" and "Speed" held words
  // some 30 px further; a value costs that.)
  for (const width of [480, 400, 370]) {
    await squeeze(page, width);
    await says();
    await placed();
  }

  // Only at the narrowest do glyphs stand in, on one row, and the pickers fold into "…".
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
  const at260 = await dump(page);
  await squeeze(page, 720);
  await page.waitForTimeout(1000);
  await expect(mode, `260: ${at260} / 720: ${await dump(page)}`).toHaveAccessibleName("Mode: Plan");
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
// TEMPORARY diagnostic for the Linux-only failure below: what each block shows, and the widths.
const dump = (page: Page) =>
  page.getByTestId("composer-toolbar").evaluate((el) => {
    const words = [...el.querySelectorAll<HTMLElement>("[data-toolbar-block]")].map((b) => {
      const shown = [
        ...b.querySelectorAll<HTMLElement>(
          "[data-toolbar-label],[data-toolbar-compact],[data-toolbar-value]",
        ),
      ]
        .filter((s) => !s.classList.contains("sr-only") && s.offsetWidth > 0)
        .map((s) => s.textContent)
        .join("");
      return `${b.dataset["toolbarBlock"]}=${shown || "∅"}(${b.offsetWidth})`;
    });
    const fixed = [...el.querySelectorAll<HTMLElement>("[data-toolbar-fixed]")].map(
      (f) => f.offsetWidth,
    );
    return `${el.clientWidth} wrapped=${el.dataset["wrapped"] ?? "-"} ${words.join(" ")} fixed=${fixed.join(",")}`;
  });

const shownWords = (picker: Locator) =>
  picker.evaluate((el) =>
    [
      ...el.querySelectorAll<HTMLElement>(
        "[data-toolbar-label], [data-toolbar-compact], [data-toolbar-value]",
      ),
    ]
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
  await expect(page.getByTestId("review-focus")).toHaveAttribute("data-narrow", "true");

  const toolbar = page.getByTestId("composer-toolbar");
  // Its laid-out width, not its box: the chat eases back in from Focus review.
  await expect.poll(() => toolbar.evaluate((el) => el.clientWidth)).toBeGreaterThan(400);
  const effort = toolbar.getByRole("combobox", { name: /^Effort: / });
  await expect(effort).toHaveAccessibleName("Effort: Model default");
  const mode = toolbar.getByRole("combobox", { name: /^Mode: / });
  await expect(mode).toHaveText(/^Mode: Ask/);
  // A readable value of three letters or more, the compact one or the whole: never the gauge alone.
  // Short, it says its own name, "Effort", not "Model", which beside the model picker read as a second.
  await expect.poll(() => shownWords(effort)).toMatch(/^(Effort: )?Default$/);
  // Speed too keeps its name, never the bolt alone.
  await expect
    .poll(() => shownWords(toolbar.getByRole("combobox", { name: /^Speed: / })))
    .toMatch(/^Speed(: Default)?$/);
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
