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
  await expect(page.getByLabel("Project path")).not.toBeFocused();
});

test("the in chip holds bookmarks and recents, Checkout is the one worktree control, and Create comes last", async ({
  page,
}) => {
  await page.goto("/new");
  const form = page.getByRole("form", { name: "New thread" });
  const folder = page.getByRole("button", { name: "Folder", exact: true });
  await expect(folder).toHaveText("api");
  // One worktree control and one base branch: no checkbox beside the Checkout choice.
  await expect(form.getByRole("radio", { name: "New worktree" })).toBeChecked();
  await expect(form.getByRole("checkbox")).toHaveCount(0);
  await expect(form.getByRole("combobox", { name: "Base branch" })).toHaveCount(1);
  await expect(form.getByRole("combobox", { name: "Start from" })).toHaveCount(0);
  // Bookmarks and Recent are in the folder menu, not on the page.
  await expect(form.getByRole("region", { name: "Recent" })).toHaveCount(0);
  // Start chat is the form's last control, after where it runs.
  const create = form.getByRole("button", { name: "Start chat" });
  const last = form.locator("button, input, textarea, [role=combobox]").last();
  await expect(last).toHaveAccessibleName("Start chat");
  expect((await create.boundingBox())!.y).toBeGreaterThan(
    (await form.getByRole("radio", { name: "New worktree" }).boundingBox())!.y,
  );
  await expect(form.getByLabel("First prompt")).toHaveAttribute(
    "placeholder",
    /leave it empty to start the agent now/,
  );

  await folder.click();
  const menu = page.getByTestId("where-folder-menu");
  await expect(menu.getByRole("region", { name: "Bookmarks" })).toContainText("api");
  await menu.getByRole("region", { name: "Recent" }).getByRole("button", { name: /^web/ }).click();
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
  await expect(page.getByRole("radio", { name: "Team", exact: true })).toBeChecked();
  // The current thread's repo has no workspace yet, so one is made on send, at Full by default.
  await expect(page.getByTestId("task-target")).toHaveText("api");
  await expect(page.getByTestId("task-autonomy")).toHaveAttribute("data-value", "full");
  await expect(page.getByTestId("autonomy-full-note")).toContainText("What does this allow?");
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

  // From the orchestrator the overview's New opens the form on its workspace; a worker starts at once.
  const add = page
    .getByTestId("overview-sidebar")
    .getByRole("button", { name: "New task", exact: true });
  await add.click();
  await page.getByTestId("new-entry-menu").getByRole("menuitem", { name: /^Team/ }).click();
  await expect(page).toHaveURL(/\/new-task$/);
  await expect(page.getByTestId("task-target")).toHaveText("api");
  await expect(page.getByTestId("task-autonomy")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Send to team/ })).toBeVisible();
  await page.getByRole("radio", { name: "Task", exact: true }).click();
  await expect(page).toHaveURL(/\/new-task\?way=direct$/);
  await expect(page.getByTestId("task-target")).toHaveText("api");
  // Beside Start, a line each: where it runs (the workspace, repository and checkout, with
  // Change), whom it reports to, and whether its merge waits for you, as a choice.
  const authority = page.getByTestId("task-authority");
  await expect(authority.getByTestId("task-destination")).toContainText(
    "Runs in api · api · New worktree, new branch",
  );
  // Opened from the orchestrator's own thread: where it runs is read off it, not remembered.
  await expect(authority.getByTestId("task-destination-remembered")).toHaveCount(0);
  await expect(authority.getByTestId("task-owner")).toHaveText("Reports to the api orchestrator");
  const approval = authority.getByRole("radiogroup", {
    name: "Merge approval for every task in api",
  });
  await expect(approval.getByRole("radio", { name: "Automatic" })).toBeChecked();
  await expect(authority.getByTestId("task-merge-approval")).toContainText(
    "Merges its pull request without asking you.",
  );
  // Where it runs is named before submit: the workspace, the repository and a new worktree.
  const where = page.getByRole("group", { name: "Where it runs" });
  await expect(where.getByTestId("task-target")).toHaveText("api");
  await expect(where.getByTestId("task-repo")).toHaveText("api");
  await expect(where.getByTestId("task-checkout")).toHaveText("New worktree, new branch");
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
  // The workspace's autonomy, in words, under Control and approvals.
  await expect(page.getByTestId("workspace-autonomy")).toHaveCount(0);
  await page.getByRole("button", { name: "Control and approvals" }).click();
  const autonomy = page.getByTestId("workspace-autonomy");
  await expect(autonomy.getByTestId("workspace-autonomy-trigger")).toHaveText(
    "Workspace: full autonomy",
  );
  // Ask, beside Start: the workspace steps down to Publish, which still opens pull requests.
  await approval.getByRole("radio", { name: "Ask" }).click();
  await expect(approval.getByRole("radio", { name: "Ask" })).toBeChecked();
  await expect(autonomy.getByTestId("workspace-autonomy-trigger")).toHaveText(
    "Workspace: publish autonomy",
  );
  await expect(authority.getByTestId("task-merge-approval")).toContainText(
    "Opens its pull request; merging waits for you.",
  );
  // Back to Automatic asks first, since nothing asks after it.
  await approval.getByRole("radio", { name: "Automatic" }).click();
  const confirm = page.getByTestId("merge-approval-confirm");
  await expect(approval.getByRole("radio", { name: "Ask" })).toBeChecked();
  await confirm.getByRole("button", { name: "Merge automatically" }).click();
  await expect(confirm).toBeHidden();
  await expect(approval.getByRole("radio", { name: "Automatic" })).toBeChecked();
  await expect(autonomy.getByTestId("workspace-autonomy-trigger")).toHaveText(
    "Workspace: full autonomy",
  );

  // Started from here, the worker is the orchestrator's and running, not held as yours.
  await expect(authority).toContainText("Reports to the api orchestrator");
  const hold = page.getByRole("switch", { name: "Start under my control" });
  await expect(hold).not.toBeChecked();
  await page.getByLabel("What needs doing").fill("Fix the retry test on Windows. It times out.");
  await page.getByRole("button", { name: /Start task/ }).click();
  // Titled from the first sentence, without its full stop.
  await expect(page.getByTestId("pane-header")).toContainText("Fix the retry test on Windows");
  await expect(page.getByTestId("pane-header")).not.toContainText("It times out");
  // Until its session opens it says it is starting, not Idle.
  await expect(
    page.getByTestId("overview-sidebar").getByTestId("overview-worker-starting"),
  ).toHaveText("Starting…");
  await expect(page.getByTestId("worker-crumbs")).toBeVisible();
  await expect(page.getByTestId("message-user").first()).toContainText(
    "Fix the retry test on Windows",
  );
  await expect(page.getByTestId("worker-hold")).toHaveCount(0);
  await expect(page.getByTestId("worker-banner-held")).toHaveCount(0);
  // Take over is offered instead (folded into the bar at this width).
  await expect(page.getByTestId("worker-take-over")).toHaveCount(1);

  // Asked for before submitting, it starts under your control, and says so in those words.
  await page
    .getByTestId("overview-sidebar")
    .getByRole("button", { name: "New task", exact: true })
    .click();
  await page.getByTestId("new-entry-menu").getByRole("menuitem", { name: /^Task/ }).click();
  await expect(page).toHaveURL(/\/new-task\?way=direct$/);
  // A repeat start to the same workspace folds who and where away: the line beside Start says
  // both, and typing starts in the brief.
  await expect(page.getByRole("radiogroup", { name: "Who does it" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Where it runs" })).toHaveCount(0);
  await expect(page.getByTestId("task-destination")).toContainText(
    "Runs in api · api · New worktree, new branch",
  );
  await expect(page.getByLabel("What needs doing")).toBeFocused();
  await expect(page.getByTestId("task-authority")).toContainText("Reports to the api orchestrator");
  await page.getByRole("button", { name: "Control and approvals" }).click();
  await page.getByRole("switch", { name: "Start under my control" }).click();
  await expect(page.getByTestId("task-authority")).toContainText(
    "You direct it until you hand it to the api orchestrator",
  );
  // Change unfolds the full choice with the workspace's menu open; the line still says who directs.
  await page.getByTestId("task-destination-change").click();
  await expect(page.getByTestId("task-target-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("radio", { name: "Task", exact: true })).toBeChecked();
  await expect(page.getByTestId("task-authority")).toContainText("You direct it");
  await page.getByLabel("What needs doing").fill("Rename the queue consumer");
  await page.getByRole("button", { name: /Start task/ }).click();
  await expect(page.getByTestId("pane-header")).toContainText("Rename the queue consumer");
  await expect(page.getByTestId("worker-banner-held")).toContainText("Under your control");
  await expect(page.getByTestId("worker-banner-held")).not.toContainText("Paused");
  await expect(page.getByTestId("worker-hold")).toBeVisible();

  // New's Task opens a repeat start folded to its line, which unfolds on it.
  await add.click();
  await page.getByTestId("new-entry-menu").getByRole("menuitem", { name: /^Task/ }).click();
  await expect(page).toHaveURL(/\/new-task\?way=direct$/);
  await page.getByTestId("task-destination-change").click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("radio", { name: "Task", exact: true })).toBeChecked();
});

test("Who does it turns a task into a one-off thread and back, keeping what was typed", async ({
  page,
}) => {
  await page.goto("/new-task");
  await page.getByLabel("What needs doing").fill("Just a quick question");
  await page.getByTestId("task-target").click();
  const menu = page.getByTestId("task-target-menu");
  await expect(menu.getByRole("menuitem", { name: /web.*makes one on send/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "New workspace" })).toBeVisible();
  await menu.getByRole("menuitem", { name: /web/ }).click();
  await expect(page.getByTestId("task-target")).toHaveText("web");

  await page.getByRole("radio", { name: "Chat", exact: true }).click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole("radio", { name: "Chat", exact: true })).toBeChecked();
  await expect(page.getByLabel("First prompt")).toHaveValue("Just a quick question");
  await expect(page.getByRole("button", { name: /Start chat/ })).toBeVisible();

  // Back to the orchestrator, the folder goes along as the repo to make a workspace for.
  await page.getByRole("radio", { name: "Team", exact: true }).click();
  await expect(page).toHaveURL(/\/new-task$/);
  await expect(page.getByTestId("task-target")).toHaveText("web");
  await expect(page.getByLabel("What needs doing")).toHaveValue("Just a quick question");
});
