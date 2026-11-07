import { expect, test, type Locator, type Page } from "@playwright/test";

/** Narrows the composer's column the way a narrow pane does, without changing the window. */
const squeeze = (page: Page, width: number) =>
  page.locator('[data-surface="composer"]').evaluate((el, w) => {
    el.style.maxWidth = `${w}px`;
  }, width);

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not laid out");
  return found;
};

// The effort and mode pickers were glyphs alone: after a pick only the gauge changed, and the open
// list marked nothing as current. Now they say their value while the row has room, check it in the
// list, and confirm a pick in words.
test("effort says its value, checks it in the list, and confirms a pick in words", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  const toolbar = page.getByTestId("composer-toolbar");
  const effort = toolbar.getByRole("combobox", { name: /^Effort: / });
  // No effort chosen: the model's own default, said as such.
  await expect(effort).toHaveAccessibleName("Effort: Model default");
  // Its words name what it picks, so the default never reads as the model picker's; its name and
  // tooltip say whose default it is.
  await expect(effort).toHaveText(/^Effort: Default/);

  await effort.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
    /^Effort: Model default \(.+\)$/,
  );

  await effort.click();
  const current = page.getByRole("option", { name: "Default effort" });
  await expect(current).toHaveAttribute("aria-selected", "true");
  await expect(current).toContainText("Whatever level the model uses");
  const xhigh = page.getByRole("option", { name: "Extra high effort" });
  await expect(xhigh).toHaveAttribute("aria-selected", "false");
  await expect(xhigh).toContainText("Reasons at length");
  await xhigh.click();

  await expect(effort).toHaveAccessibleName("Effort: Extra high");
  await expect(effort).toHaveText(/^Effort: Extra high/);
  await expect(toolbar.getByText("Effort set to Extra high")).toBeVisible();
  await effort.click();
  await expect(page.getByRole("option", { name: "Extra high effort" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Escape");

  // Narrow, the words give way and the glyph stands alone, still named with its value.
  await squeeze(page, 420);
  await expect(effort.locator("[data-toolbar-label]")).toHaveClass(/\bsr-only\b/);
  await expect(effort).toHaveAccessibleName("Effort: Extra high");
});

test("the toolbar's targets are as tall as Send, and ring on keyboard focus", async ({ page }) => {
  await page.goto("/t/t-deps");
  const toolbar = page.getByTestId("composer-toolbar");
  const effort = toolbar.getByRole("combobox", { name: /^Effort: / });
  const speed = toolbar.getByRole("combobox", { name: /^Speed: / });
  const targets = [
    toolbar.getByRole("combobox", { name: "Model", exact: true }),
    effort,
    toolbar.getByRole("combobox", { name: /^Mode: / }),
    speed,
    toolbar.getByRole("button", { name: "Send", exact: true }),
  ];
  for (const target of targets) {
    const { width, height } = await box(target);
    expect(height).toBe(32);
    expect(width).toBeGreaterThanOrEqual(32);
  }
  // The row never runs its words into Send.
  const send = await box(toolbar.getByRole("button", { name: "Send", exact: true }));
  const last = await box(speed);
  expect(send.x - (last.x + last.width)).toBeGreaterThanOrEqual(40);

  // From the message box, Tab walks the toolbar; the effort picker rings as every control does.
  await page.getByLabel("Message", { exact: true }).focus();
  for (let i = 0; i < 6 && !(await effort.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press("Tab");
  await expect(effort).toBeFocused();
  await expect(effort).toHaveCSS("outline-style", "solid");
});

test("Stop says Stop beside its square, says its key while you're in the composer, and keeps the reply", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  await page.goto("/t/t-flaky");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  // A filled pill with the word, not Send's accent and not a bare glyph.
  const fill = await stop.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(fill).not.toBe("rgba(0, 0, 0, 0)");
  await expect(stop).toHaveText("Stop");
  await expect(page.getByTestId("stop-ring")).toBeVisible();
  // Where Send sits: the right edges line up, so the spot doesn't move as the turn starts and ends.
  const send = page.getByRole("button", { name: "Send", exact: true });
  const stopRight = await stop.evaluate((el) => el.getBoundingClientRect().right);

  const key = page.getByTestId("stop-key");
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await expect(key).toHaveCSS("opacity", "0");
  await page.getByLabel("Message", { exact: true }).focus();
  await expect(key).toHaveCSS("opacity", "1");
  await expect(key).toHaveText(/^(⌘|Ctrl\+)\.$/);

  // What the turn had written when stopped stays in the thread.
  const said = page.getByText("I'll start by reading the test");
  await page.evaluate(() => window.gramMock?.release("flaky-read"));
  await expect(said).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Period");
  await expect(stop).toBeHidden();
  await expect(page.getByTestId("stop-receipt")).toContainText(/Stopped by you/);
  await expect(page.getByTestId("stop-receipt")).toContainText(/Continue/);
  expect(await send.evaluate((el) => el.getBoundingClientRect().right)).toBeCloseTo(stopRight, 0);
  await expect(said).toBeVisible();
});

// The model picker opened over the draft, hiding what was being written; every toolbar list now
// opens above the whole composer.
test("the toolbar's lists open above the composer, never over the draft", async ({ page }) => {
  await page.goto("/t/t-deps");
  const message = page.getByLabel("Message", { exact: true });
  await message.fill("Add retry coverage for the queue consumer.");
  const composer = await box(page.locator('[data-surface="composer"]'));
  const toolbar = page.getByTestId("composer-toolbar");

  await toolbar.getByRole("combobox", { name: "Model", exact: true }).click();
  const models = page.getByTestId("model-picker");
  await expect(models).toBeVisible();
  const list = await box(models);
  expect(list.y + list.height).toBeLessThanOrEqual(composer.y);
  await page.keyboard.press("Escape");

  await toolbar.getByRole("combobox", { name: /^Effort: / }).click();
  const efforts = page.locator('[data-slot="select-content"]');
  await expect(efforts).toBeVisible();
  const effortList = await box(efforts);
  expect(effortList.y + effortList.height).toBeLessThanOrEqual(composer.y);
  await page.keyboard.press("Escape");
  await expect(message).toHaveValue("Add retry coverage for the queue consumer.");
});
