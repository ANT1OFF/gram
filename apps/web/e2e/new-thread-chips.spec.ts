import { expect, test } from "@playwright/test";

test("a single agent chat opens on the prompt-first controls, not scrolled down to the path field", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/t/t-flaky");
  // The shortcut registry mounts with the app; a chord pressed before the thread renders is lost.
  await expect(page.getByTestId("pane-header")).toContainText("Fix flaky retry test");
  await page.keyboard.press("ControlOrMeta+KeyT");
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole("heading", { name: "New task", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Chat", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "Folder", exact: true })).toBeInViewport();
  await expect(page.getByLabel("First prompt")).toBeInViewport();
  // A folder to start in is there already (the one used last, in the Folder chip), so typing
  // starts in the prompt.
  await expect(page.getByLabel("First prompt")).toBeFocused();
});

test("⌘N starts a task: a repo with no workspace sets one up in New workspace, with the task", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  await expect(page.getByTestId("pane-header")).toContainText("Fix flaky retry test");
  await page.keyboard.press("ControlOrMeta+KeyN");
  await expect(page).toHaveURL(/\/new-task$/);
  await expect(page.getByRole("radio", { name: "Team", exact: true })).toBeChecked();
  // The current thread's repo has no workspace yet: New task sends only to one that exists, so
  // it says so, and picking the repo opens New workspace on it with what was typed.
  await expect(page.getByText("api has no workspace yet.")).toBeVisible();
  await expect(page.getByTestId("task-autonomy")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Send to team/ })).toBeDisabled();
  await page.getByLabel("What needs doing").fill("Add a retry to the mail trigger");
  await page.getByTestId("task-target").click();
  await page.getByTestId("task-target-menu").getByRole("menuitem", { name: /^api/ }).click();
  await expect(page).toHaveURL(/\/new-workspace\?repo=/);
  const form = page.getByRole("form", { name: "New workspace" });
  await expect(form.getByTestId("new-workspace-task")).toHaveValue(
    "Add a retry to the mail trigger",
  );
  await form.getByTestId("new-workspace-start").click();
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

  // From the orchestrator the overview's New opens the form on its workspace: Team or Chat only.
  const add = page
    .getByTestId("overview-sidebar")
    .getByRole("button", { name: "New task", exact: true });
  await add.click();
  await page.getByTestId("new-entry-menu").getByRole("menuitem", { name: /^Team/ }).click();
  await expect(page).toHaveURL(/\/new-task$/);
  await expect(page.getByTestId("task-target")).toHaveText("api");
  await expect(page.getByTestId("task-autonomy")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Send to team/ })).toBeVisible();
  const who = page.getByRole("radiogroup", { name: "Who does it" });
  await expect(who.getByRole("radio")).toHaveCount(2);
  await expect(page.getByRole("radio", { name: "Team", exact: true })).toBeChecked();
  const where = page.getByRole("group", { name: "Where it runs" });
  await expect(where.getByTestId("task-target")).toHaveText("api");
  // Beside Start, where it runs (with Change) and whether its merge waits for you, as a choice
  // that is the workspace's. The lines' words are `authority-line.test.tsx`'s.
  const authority = page.getByTestId("task-authority");
  const approval = authority.getByRole("radiogroup", {
    name: "Merge approval for api, a workspace setting",
  });
  await expect(approval.getByRole("radio", { name: "Automatic" })).toBeChecked();
  // Change beside Start opens the workspace's menu in one click, and ⌘⇧L does from the keyboard.
  await authority.getByRole("button", { name: /^Change where it runs/ }).click();
  const targets = page.getByTestId("task-target-menu");
  await expect(targets).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(targets).toBeHidden();
  await page.getByLabel("What needs doing").focus();
  await page.keyboard.press("ControlOrMeta+Shift+KeyL");
  await expect(targets).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(targets).toBeHidden();
  // The workspace's autonomy, under Control and approvals.
  await page.getByRole("button", { name: "Control and approvals" }).click();
  const autonomy = page.getByTestId("workspace-autonomy");
  await expect(autonomy.getByTestId("workspace-autonomy-trigger")).toHaveText(/full/);
  // Ask, beside Start: the workspace steps down to Publish, which still opens pull requests.
  await approval.getByRole("radio", { name: "Ask" }).click();
  await expect(approval.getByRole("radio", { name: "Ask" })).toBeChecked();
  await expect(autonomy.getByTestId("workspace-autonomy-trigger")).toHaveText(/publish/);
  await expect(page.getByTestId("undo-toast")).toBeVisible();
  // Back to Automatic asks first, since nothing asks after it.
  await approval.getByRole("radio", { name: "Automatic" }).click();
  const confirm = page.getByTestId("merge-approval-confirm");
  await expect(approval.getByRole("radio", { name: "Ask" })).toBeChecked();
  await confirm.getByRole("button", { name: "Merge automatically" }).click();
  await expect(confirm).toBeHidden();
  await expect(approval.getByRole("radio", { name: "Automatic" })).toBeChecked();
  await expect(autonomy.getByTestId("workspace-autonomy-trigger")).toHaveText(/full/);

  // The next task goes to the same orchestrator, which decides how to run it.
  await page.getByLabel("What needs doing").fill("Fix the retry test on Windows. It times out.");
  await page.getByRole("button", { name: /Send to team/ }).click();
  await expect(page).toHaveURL(orchestrator);
  await expect(page.getByTestId("message-user").last()).toContainText(
    "Fix the retry test on Windows",
  );

  // A repeat start to the same workspace folds who and where away: the line beside Start says
  // both, and typing starts in the brief. Change unfolds them, still on Team.
  await add.click();
  await page.getByTestId("new-entry-menu").getByRole("menuitem", { name: /^Team/ }).click();
  await expect(page).toHaveURL(/\/new-task$/);
  await expect(who).toHaveCount(0);
  await expect(where).toHaveCount(0);
  await expect(page.getByTestId("task-destination")).toContainText("Runs in api");
  await expect(page.getByLabel("What needs doing")).toBeFocused();
  await page.getByTestId("task-destination-change").click();
  await expect(page.getByTestId("task-target-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("radio", { name: "Team", exact: true })).toBeChecked();
});

test("Who does it turns a task into a one-off thread and back, keeping what was typed", async ({
  page,
}) => {
  await page.goto("/new-task");
  await page.getByLabel("What needs doing").fill("Just a quick question");
  await page.getByTestId("task-target").click();
  const menu = page.getByTestId("task-target-menu");
  await expect(menu.getByRole("menuitem", { name: /web.*opens New workspace/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "New workspace", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("radio", { name: "Chat", exact: true }).click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole("radio", { name: "Chat", exact: true })).toBeChecked();
  await expect(page.getByLabel("First prompt")).toHaveValue("Just a quick question");
  await expect(page.getByRole("button", { name: /Start chat/ })).toBeVisible();

  // Back to the orchestrator, the folder goes along: its repo has no workspace, which New task says.
  await page.getByRole("radio", { name: "Team", exact: true }).click();
  await expect(page).toHaveURL(/\/new-task$/);
  await expect(page.getByText(/has no workspace yet\./)).toBeVisible();
  await expect(page.getByLabel("What needs doing")).toHaveValue("Just a quick question");
});
