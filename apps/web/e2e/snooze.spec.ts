import { expect, test, type Page } from "@playwright/test";

// Snooze: a thread leaves the lists until a time, says so in its header with an Unsnooze, and
// comes back unread at that time, or sooner when it asks something. The clock is pinned late on a
// Friday in Oslo, so "Tomorrow" crosses midnight to Saturday 09:00.

test.use({ timezoneId: "Europe/Oslo" });

/** Friday 6 November 2026, 23:30 in Oslo (UTC+1). */
const FRIDAY_LATE = new Date("2026-11-06T22:30:00Z");

const start = async (page: Page) => {
  await page.clock.install({ time: FRIDAY_LATE });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
};

/**
 * Opens `t-deps`, a thread with nothing to play: a thread that asks something comes back from its
 * snooze at once, and t-flaky's turn asks for an approval as it plays, so a snooze of it from the
 * palette, which takes longer than the row menu's, could end before it is checked.
 */
const startQuiet = async (page: Page) => {
  await page.clock.install({ time: FRIDAY_LATE });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-deps");
  await page.getByLabel("Message", { exact: true }).waitFor();
};

const sidebar = (page: Page) => page.getByTestId("overview-sidebar");
const soloRow = (page: Page, threadId: string) =>
  sidebar(page).locator(`[data-testid="overview-solo"][data-thread-id="${threadId}"]`);
const snoozedLine = (page: Page) => sidebar(page).getByTestId("overview-snoozed");

test("snoozed from the row menu, a thread leaves the list until Unsnooze brings it back", async ({
  page,
}) => {
  await start(page);
  const row = soloRow(page, "t-flaky");
  await expect(row).toBeVisible();

  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Come back later" }).hover();
  // Late on Friday the evening is gone; tomorrow is Saturday 09:00, past midnight.
  await expect(page.getByTestId("menu-snooze-evening")).toHaveCount(0);
  await expect(page.getByTestId("menu-snooze-hour")).toContainText("Sat 00:30");
  const tomorrow = page.getByTestId("menu-snooze-tomorrow");
  await expect(tomorrow).toContainText("Sat 09:00");
  await tomorrow.click();

  // Out of the list, behind its folded line, and the open thread says until when.
  await expect(row.filter({ visible: true })).toHaveCount(0);
  await expect(snoozedLine(page)).toContainText("Snoozed");
  await expect(snoozedLine(page)).toContainText("1");
  await expect(page.getByTestId("pane-snoozed")).toContainText("Snoozed until Sat 09:00");

  // Unsnooze: back in the list now, not marked unread.
  await page.getByTestId("pane-unsnooze").click();
  await expect(page.getByTestId("pane-snoozed")).toHaveCount(0);
  await expect(soloRow(page, "t-flaky")).toBeVisible();
  await expect(snoozedLine(page)).toHaveCount(0);
  await expect(soloRow(page, "t-flaky")).not.toHaveAttribute("data-unread");
});

test("snoozed from the palette to a time of your own, it comes back unread at that time", async ({
  page,
}) => {
  await startQuiet(page);
  await expect(soloRow(page, "t-deps")).not.toHaveAttribute("data-unread");
  // Opened elsewhere, so coming back marks it unread rather than read where it is shown.
  const other = sidebar(page)
    .locator('[data-testid="overview-solo"]')
    .filter({
      hasNot: page.locator('[data-thread-id="t-deps"]'),
    });
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill(">Snooze");
  await palette.getByRole("option", { name: /Snooze thread/ }).click();
  await expect(palette.getByRole("option", { name: /Tomorrow/ })).toContainText("Sat 09:00");
  await palette.getByRole("option", { name: /Pick a time/ }).click();

  const dialog = page.getByTestId("snooze-dialog");
  await dialog.getByLabel("Date").fill("2026-11-07");
  await dialog.getByLabel("Time, 24-hour").fill("9pm");
  await expect(dialog.getByTestId("snooze-dialog-when")).toContainText("HH:MM");
  await expect(dialog.getByRole("button", { name: "Snooze" })).toBeDisabled();
  await dialog.getByLabel("Time, 24-hour").fill("00:45");
  await expect(dialog.getByTestId("snooze-dialog-when")).toContainText("Back Sat 00:45");
  await dialog.getByRole("button", { name: "Snooze" }).click();
  await expect(page.getByTestId("pane-snoozed")).toContainText("Snoozed until Sat 00:45");
  await expect(snoozedLine(page)).toBeVisible();

  // Look at another thread while it sleeps, then let the clock run past its time.
  await other.first().click();
  await expect(page).not.toHaveURL(/\/t\/t-deps$/);
  await page.clock.runFor("01:20:00");
  await expect(snoozedLine(page)).toHaveCount(0);
  await expect(soloRow(page, "t-deps")).toHaveAttribute("data-unread", "true");
});

test("the palette's snooze step names itself and its thread, and takes a typed time", async ({
  page,
}) => {
  await startQuiet(page);
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  const field = palette.getByRole("combobox");
  await field.fill(">Snooze");
  await palette.getByRole("option", { name: /Snooze thread/ }).click();

  // Not the search it replaced: the step says what it does, to which thread, and what to type.
  await expect(palette.getByTestId("palette-step")).toContainText("Snooze thread");
  await expect(palette.getByTestId("palette-step-subject")).toHaveText("Bump dependencies");
  await expect(field).toHaveAttribute("placeholder", "Snooze until… (e.g. fri 14:00)");
  await expect(field).toHaveAccessibleName("Snooze thread");

  // Late on Friday, "mon 14:00" is the coming Monday.
  await field.fill("mon 14:00");
  const typed = palette.getByRole("option", { name: "Snooze until Mon 14:00" });
  await expect(typed).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId("pane-snoozed")).toContainText("Snoozed until Mon 14:00");
});
