import { expect, test, type Locator } from "@playwright/test";

import { choicesPopup, openChoices } from "./composer-choices";

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not laid out");
  return found;
};

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
