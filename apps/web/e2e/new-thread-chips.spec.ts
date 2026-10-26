import { expect, test } from "@playwright/test";

test("a one-off thread opens on the prompt-first controls, not scrolled down to the path field", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/t/t-flaky");
  // The shortcut registry mounts with the app; a chord pressed before the thread renders is lost.
  await expect(page.getByTestId("pane-header")).toContainText("Fix flaky retry test");
  await page.keyboard.press("ControlOrMeta+KeyT");
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole("heading", { name: /^What should we build in/ })).toBeVisible();
  await expect(page.getByTestId("task-target")).toHaveText("One-off thread");
  await expect(page.getByTestId("where-chips")).toBeInViewport();
  await expect(page.getByLabel("First prompt")).toBeInViewport();
  await expect(page.getByLabel("Project path")).not.toBeFocused();
});

test("the headline picks the folder, and the chips under the prompt whether it gets a worktree", async ({
  page,
}) => {
  await page.goto("/new");
  const chips = page.getByTestId("where-chips");
  const folder = page.getByRole("heading", { level: 1 }).getByTestId("where-folder");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("What should we build in api?");
  await expect(folder).toHaveAccessibleDescription("Folder");
  await expect(page.getByRole("radio", { name: "New worktree" })).toBeChecked();

  await chips.getByRole("checkbox", { name: "worktree" }).uncheck();
  await expect(page.getByRole("radio", { name: "Current checkout" })).toBeChecked();
  await expect(chips.getByRole("combobox", { name: "Start from" })).toHaveCount(0);
  await chips.getByRole("checkbox", { name: "worktree" }).check();
  await expect(chips.getByRole("combobox", { name: "Start from" })).toBeVisible();

  await folder.click();
  await page.getByTestId("where-folder-menu").getByRole("button", { name: /^web/ }).click();
  await expect(folder).toHaveText("web");
  await expect(page.getByLabel("Project path")).toHaveValue("/Users/dev/code/web");

  await folder.click();
  await page.getByRole("button", { name: "Another folder…" }).click();
  await expect(page.getByLabel("Project path")).toBeFocused();
});

test("⌘N starts a task: a repo's workspace on send, its orchestrator, or a worker straight away", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  await expect(page.getByTestId("pane-header")).toContainText("Fix flaky retry test");
  await page.keyboard.press("ControlOrMeta+KeyN");
  await expect(page).toHaveURL(/\/new-task$/);
  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
  // The current thread's repo has no workspace yet, so one is made on send.
  await expect(page.getByTestId("task-target")).toHaveText("api");
  await expect(page.getByRole("radio", { name: "Orchestrator plans it" })).toBeChecked();
  const send = page.getByRole("button", { name: /Start workspace and send/ });
  await expect(send).toBeDisabled();
  await page.getByLabel("What needs doing").fill("Add a retry to the mail trigger");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page).toHaveURL(/\/t\/t-mock-/);
  await expect(page.getByTestId("pane-header").getByRole("heading")).toHaveAccessibleName(
    "Orchestrator: api",
  );
  await expect(page.getByTestId("message-user").first()).toContainText(
    "Add a retry to the mail trigger",
  );

  // With an orchestrator on screen, ⌘N is a message to it: the caret goes to its composer.
  const orchestrator = page.url();
  await page.keyboard.press("ControlOrMeta+KeyN");
  await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
  expect(page.url()).toBe(orchestrator);

  // From the orchestrator the overview's New task draft is aimed at its workspace; a worker starts
  // at once.
  await page.getByTestId("overview-sidebar").getByRole("button", { name: "New task" }).click();
  await expect(page).toHaveURL(/\/new-task$/);
  await expect(page.getByTestId("task-target")).toHaveText("api");
  await expect(page.getByRole("button", { name: /Send to orchestrator/ })).toBeVisible();
  await page.getByRole("radio", { name: "Straight to a worker" }).click();
  await expect(page.getByTestId("task-way-note")).toContainText("Starts one worker now");
  await page.getByLabel("What needs doing").fill("Fix the retry test on Windows");
  await page.getByRole("button", { name: /Start worker/ }).click();
  await expect(page.getByTestId("pane-header")).toContainText("Fix the retry test on Windows");
  await expect(page.getByTestId("worker-crumbs")).toBeVisible();
  // You wrote its first input, so it starts yours.
  await expect(page.getByTestId("worker-hold")).toBeVisible();

  // The way is remembered for the workspace.
  await page.keyboard.press("ControlOrMeta+KeyN");
  await expect(page.getByRole("radio", { name: "Straight to a worker" })).toBeChecked();
});

test("the target picker turns a task into a one-off thread and back, keeping what was typed", async ({
  page,
}) => {
  await page.goto("/new-task");
  await page.getByLabel("What needs doing").fill("Just a quick question");
  await page.getByTestId("task-target").click();
  const menu = page.getByTestId("task-target-menu");
  await expect(menu.getByRole("menuitem", { name: /web.*makes one on send/ })).toBeVisible();
  await menu.getByRole("menuitem", { name: /One-off thread/ }).click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByTestId("task-target")).toHaveText("One-off thread");
  await expect(page.getByLabel("First prompt")).toHaveValue("Just a quick question");
  await expect(page.getByRole("button", { name: /Create thread/ })).toBeVisible();

  await page.getByTestId("task-target").click();
  await page.getByTestId("task-target-menu").getByRole("menuitem", { name: /web/ }).click();
  await expect(page).toHaveURL(/\/new-task$/);
  await expect(page.getByTestId("task-target")).toHaveText("web");
  await expect(page.getByLabel("What needs doing")).toHaveValue("Just a quick question");
});
