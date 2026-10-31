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

// In a narrow pane the toolbar used to wrap, and before that it clipped Stop and Send past the
// pane's edge. Now labels give way to glyphs, then pickers fold into "…", on one row throughout.
test("the toolbar stays one row as it narrows, folding pickers into …", async ({ page }) => {
  // Held running, so Stop and Steer stay offered: the script's later approval takes Steer away.
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  await page.goto("/t/t-flaky");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  const message = page.getByLabel("Message", { exact: true });
  const toolbar = page.getByTestId("composer-toolbar");
  const mode = toolbar.getByRole("combobox", { name: "Mode", exact: true });
  await expect(mode).toContainText("Ask");

  // Speed at the CLI's default waits in "…", which is there from the start.
  const more = toolbar.getByRole("button", { name: "More composer controls" });
  await expect(more).toBeVisible();
  await expect(toolbar.getByRole("combobox", { name: "Speed", exact: true })).toHaveCount(0);
  await squeeze(page, 400);
  await expect(mode).toHaveAttribute("title", /^Mode: Ask/);
  expect(await rowSpread(page)).toBeLessThanOrEqual(1);

  await squeeze(page, 280);
  await expect(mode).toHaveCount(0);
  expect(await rowSpread(page)).toBeLessThanOrEqual(1);
  const edge = await right(message);
  expect(await right(page.getByRole("button", { name: "Stop", exact: true }))).toBeLessThanOrEqual(
    edge,
  );

  // With a draft the one button takes Queue, and stays inside the composer however narrow it gets.
  await message.fill("use the fake clock");
  await squeeze(page, 230);
  await expect(toolbar.getByRole("button", { name: "Steer now" })).toHaveCount(0);
  expect(await right(page.getByRole("button", { name: "Queue", exact: true }))).toBeLessThanOrEqual(
    await right(message),
  );
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
  await squeeze(page, 280);

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
  await expect(toolbar.getByRole("combobox", { name: "Mode", exact: true })).toContainText("Plan");
  await expect(toolbar.getByRole("combobox", { name: "Speed", exact: true })).toContainText(
    "Standard",
  );
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
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText("Stop");

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
