import { expect, test, type Page } from "@playwright/test";

import { openOrchestrator, threadRow } from "./thread-row";

// Chat · Board, Quiet, and the title bar's workspace switcher. Mock state lives in memory, so every step after the
// seed navigates inside the app.

const start = async (page: Page) => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(() => window.gramMock!.simulateAsks());
  await openOrchestrator(page, made.orchestratorThreadId);
  await expect(page.getByTestId("ask-stack")).toBeVisible();
  return made;
};

const views = (page: Page) => page.getByRole("radiogroup", { name: "View" });
const view = (page: Page, name: string) =>
  views(page).getByRole("radio", { name: new RegExp(`^${name}\\b`) });
/** The orchestrator's own stack, above its composer; Board docks another. */
const chatStack = (page: Page) => page.locator("[data-pane-root]").getByTestId("ask-stack");
const composer = (page: Page) => page.getByLabel("Message", { exact: true });

test("Chat and Board switch over the same route, and Esc comes back", async ({ page }) => {
  const made = await start(page);
  await expect(view(page, "Chat")).toHaveAttribute("aria-checked", "true");
  // The Inbox is gone: Chat and Board, and no third view.
  await expect(view(page, "Board")).toBeVisible();
  await expect(view(page, "Inbox")).toHaveCount(0);

  await view(page, "Board").click();
  await expect(page.getByTestId("view-board")).toBeVisible();
  // Laid out under Board, but hidden; Board docks its own below the lines.
  await expect(chatStack(page)).toBeHidden();
  await expect(page.getByTestId("view-board").getByTestId("ask-stack")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("view-board")).toBeHidden();
  await expect(chatStack(page)).toBeVisible();
  await expect(view(page, "Chat")).toHaveAttribute("aria-checked", "true");

  // The chords type nothing, so the composer keeps its words while they switch.
  await composer(page).fill("half a thought");
  await page.keyboard.press("ControlOrMeta+Alt+2");
  await expect(page.getByTestId("view-board")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Alt+1");
  await expect(page.getByTestId("view-board")).toBeHidden();
  await expect(composer(page)).toHaveValue("half a thought");

  // ⌘⌥3, where the Inbox was, opens the Needs you popover, and again closes it.
  await page.keyboard.press("ControlOrMeta+Alt+3");
  await expect(page.getByTestId("needs-you-popover")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Alt+3");
  await expect(page.getByTestId("needs-you-popover")).toBeHidden();
  await expect(composer(page)).toHaveValue("half a thought");

  // Opening a thread anywhere shows it, in Chat: a solo thread's one bar, with no views of the
  // workspace's in it.
  await threadRow(page, "t-flaky").click();
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
  await expect(page.getByTestId("view-board")).toBeHidden();
  await expect(page.getByTestId("shell-titlebar")).toHaveAttribute("data-solo-thread", "true");
  await expect(page.getByTestId("shell-titlebar").getByTestId("view-switcher")).toHaveCount(0);
});

test("Quiet covers the window until Esc", async ({ page }) => {
  await start(page);
  // Wide enough that the orchestrator's title bar keeps Quiet out of its folded "…".
  await page.setViewportSize({ width: 1680, height: 900 });
  await page.getByTestId("quiet-toggle").click();
  await expect(page.getByTestId("quiet-layer")).toBeVisible();
  await expect(page.getByTestId("app-shell")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("quiet-layer")).toBeHidden();
  await expect(page.getByTestId("app-shell")).not.toHaveAttribute("inert");

  await page.keyboard.press("ControlOrMeta+Alt+4");
  await expect(page.getByTestId("quiet-layer")).toBeVisible();
  await page.getByRole("button", { name: /^Leave quiet/ }).click();
  await expect(page.getByTestId("quiet-layer")).toBeHidden();
});

test("the switcher with its keys, counts and solo threads, and ⌘1–⌘9 switch workspace", async ({
  page,
}) => {
  const made = await start(page);
  const button = page.getByTestId("workspace-switcher-button");
  await button.click();
  const popover = page.getByTestId("workspace-switcher");
  const items = popover.locator("[data-switcher-item]");
  const rows = items.filter({ has: page.locator("kbd") });
  await expect(rows).toHaveCount(2);
  // The second workspace's one ask, as its own stack counts it.
  await expect(rows.nth(1).getByTestId("workspace-ask-count")).toHaveText("1");
  await expect(rows.nth(0)).toContainText("agent-platform");
  await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");
  // Solo threads list what lives outside the workspaces, and open it.
  const solo = popover.getByTestId("solo-threads");
  await expect(solo.getByRole("button", { name: /Fix flaky/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // ⌘2 goes to the second workspace's orchestrator, keeping Board.
  await view(page, "Board").click();
  await page.keyboard.press("ControlOrMeta+2");
  await expect(page).toHaveURL(new RegExp(`/t/${made.other.orchestratorThreadId}$`));
  await expect(page.getByTestId("view-board")).toBeVisible();
  await expect(button).toHaveAccessibleName(/billing/);
  await page.keyboard.press("ControlOrMeta+1");
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await page.keyboard.press("Escape");

  // Not while typing: the composer keeps focus and the window stays put.
  await composer(page).fill("draft");
  for (const keys of [
    "ControlOrMeta+2",
    "ControlOrMeta+3",
    "ControlOrMeta+4",
    "ControlOrMeta+5",
    "ControlOrMeta+6",
    "ControlOrMeta+7",
    "ControlOrMeta+8",
    "ControlOrMeta+9",
  ]) {
    await page.keyboard.press(keys);
  }
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveValue("draft");

  await button.click();
  await page
    .getByTestId("solo-threads")
    .getByRole("button", { name: /Fix flaky/ })
    .click();
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
});
