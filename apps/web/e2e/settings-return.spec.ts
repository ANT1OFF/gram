import { expect, test, type Page } from "@playwright/test";

import { openOrchestrator } from "./thread-row";

// Settings takes the window's place, and leaving it, by Back, Esc or the history, comes back to
// exactly where you were: the same thread, read at the same place, with the same panel.

/** The row at the top of the transcript's view, and how far the view's top is past its start. */
const readingPlace = (page: Page) =>
  page.getByTestId("transcript").evaluate((scroller) => {
    const top = scroller.getBoundingClientRect().top;
    const rows = [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")];
    const row = rows.find((each) => each.getBoundingClientRect().bottom > top + 1)!;
    return {
      id: row.dataset.messageId!,
      past: Math.round(top - row.getBoundingClientRect().top),
      following: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1,
    };
  });

const panelState = (page: Page) =>
  page.evaluate(() => ({
    open: document.querySelector('[data-testid="right-panel"]') !== null,
    tab:
      document
        .querySelector('[data-testid="right-panel"] [role="tab"][aria-selected="true"]')
        ?.textContent?.trim() ?? null,
  }));

/** The Gram orchestrator of the realistic scenario, read halfway up its long transcript. */
async function readHalfway(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem("gram.mock.orchestration", "realistic"));
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  const made = await page.evaluate(async () => (await window.gramMock!.startedRealistic())!);
  await openOrchestrator(page, made.orchestratorThreadId);
  const transcript = page.getByTestId("transcript");
  await expect(transcript.locator("[data-message-id]").first()).toBeVisible();
  // Up by the wheel, as a reader would, so the transcript stops following its end.
  await transcript.hover();
  for (let i = 0; i < 2; i++) await page.mouse.wheel(0, -330);
  await expect.poll(async () => (await readingPlace(page)).following).toBe(false);
  await page.waitForTimeout(300);
  const place = await readingPlace(page);
  // Somewhere in the middle of a row, so coming back to the row alone wouldn't pass.
  expect(place.past).toBeGreaterThan(8);
  return { made, place };
}

const expectSamePlace = async (page: Page, place: Awaited<ReturnType<typeof readingPlace>>) => {
  await expect
    .poll(async () => {
      const now = await readingPlace(page);
      return now.id === place.id && Math.abs(now.past - place.past) <= 2;
    })
    .toBe(true);
};

test("Settings' Back and Esc come back to the same thread, read at the same place, panel as it was", async ({
  page,
}) => {
  const { made, place } = await readHalfway(page);
  const thread = new RegExp(`/t/${made.orchestratorThreadId}$`);
  const panel = await panelState(page);

  await page.keyboard.press("ControlOrMeta+Comma");
  const back = page.getByTestId("settings-back");
  // Back names where it goes.
  await expect(back).toHaveAccessibleName("Back to Gram");
  await page
    .getByRole("link", { name: /Agents/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/settings\/agents/);
  await back.click();
  await expect(page).toHaveURL(thread);
  await expectSamePlace(page, place);
  expect(await panelState(page)).toEqual(panel);

  // Esc, from a section a page deeper, does the same.
  await page.keyboard.press("ControlOrMeta+Comma");
  await page
    .getByRole("link", { name: /Appearance/ })
    .first()
    .click();
  await page.locator("body").press("Escape");
  await expect(page).toHaveURL(thread);
  await expectSamePlace(page, place);

  // And so does the browser's back, from Settings opened once.
  await page.keyboard.press("ControlOrMeta+Comma");
  await expect(back).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(thread);
  await expectSamePlace(page, place);
});

test("a deep link into a Settings section returns to its thread, even after a reload there", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.click();
  // The composer's /help goes straight to a section of Settings.
  await page.keyboard.type("/help");
  await expect(page.getByRole("listbox")).toBeVisible();
  // Enter takes the command, and Enter again runs it.
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("/help ");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings\/help/);
  await expect(page.getByTestId("settings-back")).toHaveAccessibleName("Back to Bump dependencies");

  // A reload in Settings still knows where it came from.
  await page.reload();
  await expect(page.getByTestId("settings-title")).toBeVisible();
  await expect(page.getByTestId("settings-back")).toHaveAccessibleName("Back to Bump dependencies");
  await page.getByTestId("settings-back").click();
  await expect(page).toHaveURL(/\/t\/t-deps$/);
});
