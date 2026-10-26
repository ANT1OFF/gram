import { expect, test, type Page } from "@playwright/test";

import { MENU_CAP } from "../src/palette/menu-caps";
import { pressFirstWorkspaceKey, threadRow } from "./thread-row";

// The orchestrator composer's "/" verbs: "/" on the
// orchestrator opens Task, Pause, Memory, Board, Files, Repo, Fresh and More…, each the action Gram
// has elsewhere; a worker's composer keeps the slash menu. Mock state lives in memory, so every step
// after the seed stays inside the app.

const composer = (page: Page) => page.locator('[data-pane-root] textarea[aria-label="Message"]');
const verbMenu = (page: Page) => page.getByRole("listbox", { name: "Orchestrator commands" });
const slashMenu = (page: Page) => page.getByRole("listbox", { name: "Slash commands" });

/** The One thread scenario, on the orchestrator's home. */
const home = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.getByTestId("ask-stack")).toBeVisible();
  return made;
};

const backHome = async (page: Page, orchestrator: string) => {
  // A page that opens on a field, as New task does, keeps ⌘1 for typing.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+1");
  await expect(page).toHaveURL(new RegExp(`/t/${orchestrator}$`));
  await expect(composer(page)).toHaveValue("");
};

/**
 * Types `/name` into the orchestrator's composer and picks the first verb with Enter. A verb that
 * leaves the page is checked for its cleared `/` on coming back.
 */
const pick = async (page: Page, name: string, leaves = false) => {
  await composer(page).click();
  await composer(page).fill("");
  await composer(page).pressSequentially(`/${name}`);
  await expect(verbMenu(page)).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(verbMenu(page)).toBeHidden();
  if (!leaves) await expect(composer(page)).toHaveValue("");
};

test("/ on the orchestrator opens its verbs, seven and More…, one word each", async ({ page }) => {
  await home(page);
  await composer(page).click();
  await page.keyboard.type("/");
  await expect(verbMenu(page)).toBeVisible();
  const labels = (await verbMenu(page).getByRole("option").allTextContents()).map((t) => t.trim());
  expect(labels).toEqual(["Task", "Pause", "Memory", "Board", "Files", "Repo", "Fresh", "More…"]);
  expect(labels.filter((label) => label !== "More…").length).toBeLessThanOrEqual(MENU_CAP);
  await expect(slashMenu(page)).toHaveCount(0);

  // A name no verb starts goes to the agent's and Gram's commands, as before.
  await page.keyboard.type("mod");
  await expect(verbMenu(page)).toHaveCount(0);
  await expect(slashMenu(page).getByRole("option", { name: /\/model/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(slashMenu(page)).toHaveCount(0);
});

test("each verb does what Gram does for it elsewhere", async ({ page }) => {
  const made = await home(page);
  const orchestrator = made.orchestratorThreadId;

  await pick(page, "b");
  await expect(page.getByTestId("view-board")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Alt+1");
  await expect(page.getByTestId("view-board")).toHaveCount(0);

  await pick(page, "memory", true);
  await expect(page).toHaveURL(/\/w\/[^/]+\/memory$/);
  await backHome(page, orchestrator);

  await pick(page, "task", true);
  await expect(page).toHaveURL(/\/new-task$/);
  // The URL can change before the draft mounts and takes focus. Wait for that initial focus
  // before backHome blurs it; otherwise it can take focus again before ⌘1, which skips typing.
  await expect(page.getByRole("combobox", { name: "What needs doing", exact: true })).toBeFocused();
  await backHome(page, orchestrator);

  await pick(page, "files", true);
  await expect(page).toHaveURL(/\/w\/[^/]+\/files$/);
  await backHome(page, orchestrator);

  await pick(page, "fresh");
  await expect(page.getByTestId("fresh-session-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("fresh-session-dialog")).toBeHidden();

  await pick(page, "repo");
  await expect(page.getByTestId("add-repo-dialog")).toBeVisible();
  await expect(page.getByTestId("add-repo-dialog")).toContainText("Add a repository to");
  // Its field's suggestions take the first Esc, so Cancel closes it.
  await page.getByTestId("add-repo-dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("add-repo-dialog")).toBeHidden();

  await pick(page, "more");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await expect(page.getByTestId("palette-scope")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toBeHidden();

  // Pause says so with Undo, and the verb then reads Resume, which resumes.
  await pick(page, "pause");
  await expect(page.getByText(/^Paused /).first()).toBeVisible();
  await composer(page).click();
  await page.keyboard.type("/");
  await expect(verbMenu(page).getByRole("option", { name: "Resume" })).toBeVisible();
  await verbMenu(page).getByRole("option", { name: "Resume" }).click();
  await expect(composer(page)).toHaveValue("");
  await composer(page).click();
  await page.keyboard.type("/");
  await expect(verbMenu(page).getByRole("option", { name: "Pause" })).toBeVisible();
});

test("a worker's composer keeps the slash menu in the Orchestrator layout", async ({ page }) => {
  const made = await home(page);
  await threadRow(page, made.asking).click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.asking}$`));
  await composer(page).click();
  await page.keyboard.type("/");
  await expect(slashMenu(page)).toBeVisible();
  await expect(verbMenu(page)).toHaveCount(0);
});
