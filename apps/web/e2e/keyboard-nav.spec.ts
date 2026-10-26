import { expect, test, type Page } from "@playwright/test";

import { slowdown } from "./slowdown";
import { threadRow } from "./thread-row";

/**
 * Opens the fixture thread and returns its composer once a message row is in the transcript. The
 * thread view can paint before its messages arrive, and ⌥↑ / ⌥↓ do nothing with no row to step from.
 */
const openFlakyThread = async (page: Page) => {
  await page.goto("/t/t-flaky");
  await expect(page.getByTestId("transcript").locator("[data-message-id]").first()).toBeVisible({
    timeout: 10_000 * slowdown,
  });
  return page.locator('textarea[aria-label="Message"]').first();
};

test("Esc leaves Settings from any tab, back to the thread", async ({ page }) => {
  const composer = await openFlakyThread(page);
  await composer.click();

  await page.keyboard.press("ControlOrMeta+Comma");
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeFocused();

  const appearance = page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Appearance" });
  await appearance.click();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await expect(appearance).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
  await expect(composer).toBeFocused();
});

test("⌘L, ⌘⌥S and ⌘⌥P move focus between composer, sidebar and panel; ⌥↑ / ⌥↓ step through messages", async ({
  page,
}) => {
  const composer = await openFlakyThread(page);
  await composer.click();

  // The sidebar is the overview: the focus lands on the row of the thread in view.
  await page.keyboard.press("ControlOrMeta+Alt+KeyS");
  await expect(threadRow(page, "t-flaky")).toBeFocused();

  await page.keyboard.press("ControlOrMeta+Alt+KeyP");
  await expect(page.getByTestId("right-panel").getByRole("tab", { selected: true })).toBeFocused();

  await page.keyboard.press("ControlOrMeta+KeyL");
  await expect(composer).toBeFocused();

  // Nothing focused in the focused pane: ⌥↓ picks the first visible message, then walks on.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const focusedIndex = () =>
    page.evaluate(() => {
      const row = document.activeElement?.closest<HTMLElement>("[data-index]");
      return row ? Number(row.dataset.index) : undefined;
    });
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(focusedIndex).toBeDefined();
  const first = (await focusedIndex())!;
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(focusedIndex).toBe(first + 1);
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(focusedIndex).toBe(first);
});

test("the shortcuts overlay opens from the composer, lists the whole catalog and returns focus", async ({
  page,
}) => {
  const composer = await openFlakyThread(page);
  await composer.click();

  await page.keyboard.press("ControlOrMeta+Slash");
  const overlay = page.getByTestId("shortcut-overlay");
  await expect(overlay).toBeVisible();
  await expect(composer).toHaveValue("");
  // Terminal and Settings shortcuts are listed without either being open.
  await expect(overlay.getByRole("region", { name: "Terminal" })).toContainText("Find in terminal");
  await expect(overlay.getByRole("region", { name: "App" })).toContainText("Leave settings");

  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();
  await expect(composer).toBeFocused();
});

test("keyboard only: actions palette, ? overlay, rename, pickers, refresh, send to a new draft, create", async ({
  page,
}) => {
  const composer = await openFlakyThread(page);
  await composer.click();

  await page.keyboard.press("ControlOrMeta+Shift+KeyP");
  const search = page.getByLabel("Go to, or > for commands");
  await expect(search).toHaveValue(/^>/);
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  // The palette hands focus back to the composer once its exit ends, which can be after the search
  // is hidden: blurring before that leaves the composer to take the "?" as text.
  await expect(composer).toBeFocused();

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcut-overlay")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcut-overlay")).toBeHidden();

  await composer.click();
  await page.keyboard.press("F2");
  await expect(page.getByTestId("rename-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("rename-dialog")).toBeHidden();

  for (const keys of ["ControlOrMeta+Shift+KeyM", "ControlOrMeta+Shift+KeyA"]) {
    await composer.click();
    await page.keyboard.press(keys);
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toBeHidden();
  }
  await composer.click();
  await page.keyboard.press("ControlOrMeta+Shift+KeyE");
  await expect(
    page.getByRole("listbox").or(page.getByText("This model has no effort levels")),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  const refresh = page.getByTestId("right-panel").getByRole("button", { name: /Refresh/ });
  await expect(refresh).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Alt+KeyR");
  await expect(refresh).toBeEnabled();

  await composer.fill("sent from the keyboard");
  await page.keyboard.press("ControlOrMeta+Alt+Enter");
  await expect(page).toHaveURL(/\/new$/);

  await page.getByRole("combobox", { name: "Project path" }).fill("~/Documents/code/gram");
  await expect(page.getByTestId("folder-status")).toContainText("git");
  await page.getByLabel("First prompt").fill("created from the keyboard");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page).toHaveURL(/\/t\/t-mock-/);

  await page.keyboard.press("ControlOrMeta+KeyN");
  await expect(page).toHaveURL(/\/new-task$/);
  await expect(page.getByLabel("What needs doing")).toBeFocused();
});

test("keyboard only: ⌥⏎ allows a pending approval always", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Alt+Enter");
  await expect(card).toBeHidden();
});

test("approval counter buttons keep keyboard focus and shortcuts answer the selected approval", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    for (let i = 1; i <= 3; i++)
      window.gramMock?.simulateRequest("t-deps" as never, {
        kind: "approval",
        id: `counter-${i}` as never,
        toolName: "Bash",
        displayName: `Command ${i}`,
        input: { command: `echo ${i}` },
        suggestions: [],
      });
  });
  const nav = page.getByRole("navigation", { name: "Approval navigation" });
  const next = nav.getByRole("button", { name: "Next approval" });
  const previous = nav.getByRole("button", { name: "Previous approval" });
  await expect(nav).toContainText("1/3");
  await expect(previous).toBeDisabled();
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(next).toBeFocused();
  await expect(nav).toContainText("2/3");
  await expect(page.getByRole("region", { name: "Allow Command 2?" })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(nav).toContainText("3/3");
  await expect(next).toBeDisabled();
  await previous.focus();
  await page.keyboard.press("Enter");
  await expect(nav).toContainText("2/3");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Enter");
  await expect(nav).toContainText("2/2");
  await expect(page.getByRole("region", { name: "Allow Command 3?" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(nav).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Allow Command 1?" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  await expect(page.getByTestId("pane-status")).toHaveText("Idle");
});

test("keyboard only: layout presets, ⌘⌥ arrows between panes, and ⌘W", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const panes = page.getByTestId("pane");
  const focusedPane = () =>
    page.evaluate(
      () => document.querySelector<HTMLElement>('[data-focused="true"]')?.dataset.paneIndex,
    );

  await expect(panes).toHaveCount(1);
  await expect(page.getByTestId("thread-view")).toBeVisible();

  await page.keyboard.press("Control+Shift+Digit5");
  await expect(panes).toHaveCount(6);
  await page.keyboard.press("Control+Shift+Digit6");
  await expect(panes).toHaveCount(6);
  // ⌘1–⌘9 switch workspace now, so the walk starts from the pane the thread stayed in.
  await expect.poll(focusedPane).toBe("0");

  // 3 columns × 2 rows: 0 1 2 over 3 4 5.
  for (const [keys, index] of [
    ["ControlOrMeta+Alt+ArrowRight", "1"],
    ["ControlOrMeta+Alt+ArrowDown", "4"],
    ["ControlOrMeta+Alt+ArrowLeft", "3"],
    ["ControlOrMeta+Alt+ArrowUp", "0"],
  ] as const) {
    await page.keyboard.press(keys);
    await expect.poll(focusedPane).toBe(index);
  }

  await page.keyboard.press("Control+Shift+Digit2");
  await expect(panes).toHaveCount(2);
  await page.keyboard.press("Control+Shift+Digit1");
  await expect(panes).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+KeyW");
  await expect(page).toHaveURL(/\/$/);
});

test("keyboard only: ⌘⇧U jumps to the thread that needs you, ⌘⇧O and ⌘⇧N open windows", async ({
  page,
}) => {
  await page.goto("/t/t-release");
  // The threads have to be loaded for there to be one that needs you.
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  await expect(page.getByTestId("thread-view")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+KeyU");
  await expect(page).not.toHaveURL(/\/t\/t-release$/);
  await expect(page).toHaveURL(/\/t\/t-/);

  for (const keys of ["ControlOrMeta+Shift+KeyO", "ControlOrMeta+Shift+KeyN"]) {
    const opened = page.context().waitForEvent("page");
    await page.keyboard.press(keys);
    const window = await opened;
    await window.close();
  }
});
