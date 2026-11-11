import { expect, test, type Locator, type Page } from "@playwright/test";

import { chipFace, choicesChip, choicesPopup, openChoices } from "./composer-choices";

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

// The composer's model, effort, mode and speed were four chips that crowded Send. They are one
// chip now: the model's name and the mode's glyph on it, its name and tooltip every value, and its
// popover a section for each that checks the value and confirms a pick in words.
test("effort says its value, checks it in its section, and confirms a pick in words", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  const toolbar = page.getByTestId("composer-toolbar");
  const chip = choicesChip(toolbar);
  // No effort chosen: the model's own default, said as such in the name, not on the chip.
  await expect(chip).toHaveAccessibleName(/ · Effort: Model default \(.+\) · /);
  const face = { words: "Opus", glyphs: ["mode:default"] };
  await expect.poll(() => chipFace(chip)).toEqual(face);

  await chip.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
    /Effort: Model default \(.+\)/,
  );

  await openChoices(page, toolbar, "effort");
  const efforts = page.getByRole("listbox", { name: "Effort" });
  const current = efforts.getByRole("option", { name: "Default effort" });
  await expect(current).toHaveAttribute("aria-selected", "true");
  await expect(current).toContainText("Whatever level the model uses");
  const xhigh = efforts.getByRole("option", { name: "Extra high effort" });
  await expect(xhigh).toHaveAttribute("aria-selected", "false");
  await expect(xhigh).toContainText("Reasons at length");
  await xhigh.click();

  await expect(chip).toHaveAccessibleName(/ · Effort: Extra high \(.+\) · /);
  // Effort matters for neither safety nor cost enough for a glyph: its name says it.
  await expect.poll(() => chipFace(chip)).toEqual(face);
  await expect(toolbar.getByText("Effort set to Extra high")).toBeVisible();
  // Its shortcut opens the popover on its section, the current value checked and focused.
  await page.getByLabel("Message", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+Shift+KeyE");
  const checked = page
    .getByRole("listbox", { name: "Effort" })
    .getByRole("option", { name: "Extra high effort" });
  await expect(checked).toHaveAttribute("aria-selected", "true");
  await expect(checked).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(choicesPopup(page)).toBeHidden();

  // Narrow, the chip says the same, and the name still says every value.
  await squeeze(page, 420);
  await expect.poll(() => chipFace(chip)).toEqual(face);
  await expect(chip).toHaveAccessibleName(/ · Effort: Extra high \(.+\) · /);
});

test("the toolbar's targets are as tall as Send, and ring on keyboard focus", async ({ page }) => {
  await page.goto("/t/t-deps");
  const toolbar = page.getByTestId("composer-toolbar");
  const chip = choicesChip(toolbar);
  const send = toolbar.getByRole("button", { name: "Send", exact: true });
  for (const target of [chip, send]) {
    const { width, height } = await box(target);
    expect(height).toBe(32);
    expect(width).toBeGreaterThanOrEqual(32);
  }
  // The row never runs its words into Send.
  const last = await box(chip);
  expect((await box(send)).x - (last.x + last.width)).toBeGreaterThanOrEqual(48);

  // From the message box, Tab reaches the chip, which rings as every control does.
  await page.getByLabel("Message", { exact: true }).focus();
  for (let i = 0; i < 6 && !(await chip.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press("Tab");
  await expect(chip).toBeFocused();
  await expect(chip).toHaveCSS("outline-style", "solid");
});
test("Stop is an icon in Send's place, its word and key on hover, and keeps the reply", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  await page.goto("/t/t-flaky");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  // Filled, not Send's accent and not a faint outline; Send's size, with no word and no key cap.
  const fill = await stop.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(fill).not.toBe("rgba(0, 0, 0, 0)");
  await expect(stop).toHaveText("");
  expect(await box(stop)).toMatchObject({ width: 32, height: 32 });
  await expect(page.getByTestId("stop-ring")).toBeVisible();
  // Its word and its key are its tooltip, "Stop (⌘.)", as every icon button's are.
  await stop.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(/^Stop \((⌘|Ctrl\+)\.\)$/);
  // Where Send sits: the right edges line up, so the spot doesn't move as the turn starts and ends.
  const send = page.getByRole("button", { name: "Send", exact: true });
  const stopRight = await stop.evaluate((el) => el.getBoundingClientRect().right);

  await page.locator("body").click({ position: { x: 5, y: 300 } });

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

// The model picker opened over the draft, hiding what was being written; the choices popover opens
// above the whole composer, whichever section is open.
test("the choices open above the composer, never over the draft", async ({ page }) => {
  await page.goto("/t/t-deps");
  const message = page.getByLabel("Message", { exact: true });
  await message.fill("Add retry coverage for the queue consumer.");
  const composer = await box(page.locator('[data-surface="composer"]'));
  const toolbar = page.getByTestId("composer-toolbar");

  await openChoices(page, toolbar, "model");
  await expect(page.getByTestId("model-picker")).toBeVisible();
  const popup = choicesPopup(page);
  const above = async () => {
    const shown = await box(popup);
    expect(shown.y + shown.height).toBeLessThanOrEqual(composer.y);
  };
  await above();
  await openChoices(page, toolbar, "effort");
  await expect(page.getByRole("listbox", { name: "Effort" })).toBeVisible();
  await above();
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(message).toHaveValue("Add retry coverage for the queue consumer.");
});
