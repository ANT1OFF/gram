import { expect, test } from "@playwright/test";

import { showsFocus } from "./titlebar-menu";

import { openOverviewDensity } from "./overview-density";
import { seedTheme } from "./seed-theme";

// The overview header's `+` opens the one New form: the goal, where it goes, and Who does it (a
// task for one worker through to a PR, a team under an orchestrator, or a chat with one agent). Its place in the header at each width is in
// sidebar-top-utilities.spec.ts.

test("New is one form: Who does it, an in chip with New workspace, and the shortcuts preset it", async ({
  page,
}) => {
  await seedTheme(page, { palette: "minimal-ocean", mode: "dark", motion: "off" });
  const board = await openOverviewDensity(page, 180);
  const before = await page.evaluate(async () => ({
    threads: window.gramMock!.world.threads().length,
    workspaces: (await window.gramMock!.listWorkspaces()).length,
  }));
  const sidebar = page.getByTestId("overview-sidebar");
  const add = sidebar.getByRole("button", { name: "New task", exact: true });
  await expect(add).toHaveAttribute("aria-haspopup", "menu");
  await sidebar.getByRole("button", { name: "Compact overview", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(add).toBeFocused();
  expect(await showsFocus(add)).toBe(true);

  // Enter opens New's menu: Task, Team and Chat, each with its shortcut, in Who does it's order.
  await page.keyboard.press("Enter");
  const newMenu = page.getByTestId("new-entry-menu");
  await expect(newMenu.getByRole("menuitem")).toHaveText([/^Task.+N$/, /^Team.+N$/, /^Chat.+T$/]);
  // Team opens the form on the orchestrator, aimed at the workspace on screen.
  await newMenu.getByRole("menuitem", { name: /^Team/ }).click();
  await expect(page).toHaveURL(/\/new-task$/);
  const draft = page.getByRole("form", { name: "New task" });
  await expect(draft.getByRole("heading", { name: "New", exact: true })).toBeVisible();
  const who = draft.getByRole("radiogroup", { name: "Who does it" });
  // Each choice is named plainly and says what comes of it in one sentence.
  for (const [index, name] of ["Task", "Team", "Chat"].entries())
    await expect(who.getByRole("radio").nth(index)).toHaveAccessibleName(name);
  await expect(who.getByRole("radio")).toHaveText([
    /in its own worktree and opens a pull request/,
    /An orchestrator splits it up, runs workers/,
    /You and one agent in a folder/,
  ]);
  await expect(who.getByRole("radio", { name: "Team", exact: true })).toBeChecked();
  await expect(draft.getByTestId("task-target")).toHaveText("agent-platform");
  await expect(draft.getByText(/^Orchestrator: /)).toBeVisible();

  // Worker keeps the goal and the workspace.
  await draft.getByLabel("What needs doing").fill("Synthetic draft kept for review");
  await who.getByRole("radio", { name: "Task", exact: true }).click();
  await expect(page).toHaveURL(/\/new-task\?way=direct$/);
  await expect(draft.getByTestId("task-target")).toHaveText("agent-platform");
  await expect(draft.getByLabel("What needs doing")).toHaveValue("Synthetic draft kept for review");
  // Its footer names the worker, not the orchestrator that only keeps track of it.
  await expect(draft.getByRole("group", { name: "Worker" })).toBeVisible();
  await expect(draft.getByText(/^Orchestrator: /)).toHaveCount(0);

  // The in chip lists the workspaces and New workspace.
  await draft.getByTestId("task-target").click();
  const menu = page.getByTestId("task-target-menu");
  await expect(menu.getByRole("menuitem", { name: /agent-platform/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "New workspace" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Opened again, New starts on the worker, the choice used last.
  await add.click();
  await expect(page).toHaveURL(/\/new-task\?way=direct$/);
  await expect(who.getByRole("radio", { name: "Task", exact: true })).toBeChecked();

  // ⌘N is still the agent team, ⌥⌘N one worker, ⌘T a single agent chat.
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page).toHaveURL(/\/new-task$/);
  await expect(who.getByRole("radio", { name: "Team", exact: true })).toBeChecked();
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await expect(page).toHaveURL(/\/new-task\?way=direct$/);
  await expect(who.getByRole("radio", { name: "Task", exact: true })).toBeChecked();
  await page.keyboard.press("ControlOrMeta+t");
  await expect(page).toHaveURL(/\/new$/);
  await expect(
    page
      .getByRole("radiogroup", { name: "Who does it" })
      .getByRole("radio", { name: "Chat", exact: true }),
  ).toBeChecked();

  // A workspace named by the route is the target.
  await page.evaluate((id) => {
    history.pushState({}, "", `/new-task?way=direct&workspace=${id}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, board.workspaceId);
  await expect(draft.getByTestId("task-target")).toHaveText("agent-platform");

  const after = await page.evaluate(async () => ({
    threads: window.gramMock!.world.threads().length,
    workspaces: (await window.gramMock!.listWorkspaces()).length,
  }));
  expect(after).toEqual(before);
});

test("worker draft keeps the selected unavailable provider blocked without creating anything", async ({
  page,
}) => {
  await seedTheme(page, { palette: "minimal-ocean", mode: "dark", motion: "off" });
  await openOverviewDensity(page, 180);
  await page.evaluate(() => {
    const mock = window.gramMock!;
    mock.agentSupport = async (model) => ({
      model,
      checkedAt: 1,
      availability: {
        state: "signedOut",
        reason: "Synthetic provider is signed out; log in explicitly.",
      },
      support: {
        orchestrator: { state: "supported", evidence: "Explicit synthetic orchestrator policy" },
        worker: { state: "supported", evidence: "Explicit synthetic worker policy" },
      },
    });
  });
  const before = await page.evaluate(() => window.gramMock!.world.threads().length);
  await page
    .getByTestId("overview-sidebar")
    .getByRole("button", { name: "New task", exact: true })
    .click();
  await page.getByTestId("new-entry-menu").getByRole("menuitem", { name: /^Task/ }).click();
  const draft = page.getByRole("form", { name: "New task" });
  await draft.getByRole("radio", { name: "Task", exact: true }).click();
  await expect(draft.getByRole("radio", { name: "Task", exact: true })).toBeChecked();
  await draft.getByLabel("What needs doing").fill("Synthetic refusal fixture");
  await expect(
    draft.getByText("Synthetic provider is signed out; log in explicitly.").first(),
  ).toBeVisible();
  await expect(draft.getByRole("button", { name: /Start.*worker/ })).toBeDisabled();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page).toHaveURL(/\/new-task\?way=direct/);
  expect(await page.evaluate(() => window.gramMock!.world.threads().length)).toBe(before);
});
