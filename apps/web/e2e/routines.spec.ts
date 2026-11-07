import { expect, test, type Page } from "@playwright/test";

import { openOrchestrator, threadRow } from "./thread-row";

/** A workspace of its own, opened at its settings page; its id. */
const openWorkspace = async (page: Page) => {
  await page.goto("/settings/workspaces");
  await page.waitForFunction(() => window.gramMock !== undefined);
  const workspaceId = await page.evaluate(async () => {
    const api = window.gramMock!;
    const project = (await api.listProjects())[0]!;
    const state = await api.saveWorkspace({
      name: "Routines fixture",
      projectIds: [project.id],
      homeProjectId: project.id,
    });
    return state.workspace.id;
  });
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "General", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Workspaces & merging", exact: true })
    .click();
  await page
    .getByRole("listitem", { name: "Workspace Routines fixture" })
    .getByTestId("workspace-link")
    .click();
  await page.getByTestId("workspace-page").waitFor();
  return workspaceId;
};

/** The workspace's routines as its charter keeps them. */
const routinesOf = (page: Page, workspaceId: string) =>
  page.evaluate(
    async (id) =>
      (await window.gramMock!.listWorkspaces()).find((state) => state.workspace.id === id)!.charter
        .routines ?? [],
    workspaceId,
  );

/** Saves `routines` in the workspace's charter, as the orchestrator's tool or settings chat would. */
const setRoutines = (page: Page, workspaceId: string, routines: unknown[], pause = false) =>
  page.evaluate(
    async ({ id, list, paused }) => {
      const api = window.gramMock!;
      const state = (await api.listWorkspaces()).find((each) => each.workspace.id === id)!;
      await api.setOrchestratorCharter(id as never, { ...state.charter, routines: list } as never);
      if (paused) await api.setOrchestratorPaused(id as never, true);
    },
    { id: workspaceId, list: routines, paused: pause },
  );

test("adds a routine, refuses a 12-hour time, and saves its schedule and target", async ({
  page,
}) => {
  const workspaceId = await openWorkspace(page);
  const section = page.getByTestId("workspace-routines");
  await expect(section.getByTestId("routines-empty")).toHaveText("No routines yet");

  await page.getByTestId("routine-add").click();
  // A dialog of its own, its header naming the workspace, Save and Cancel in view below the form.
  const editor = page.getByTestId("routine-editor");
  await expect(editor.getByRole("heading", { name: "New routine" })).toBeVisible();
  await expect(editor.getByTestId("routine-editor-workspace")).toHaveText("Routines fixture");
  await expect(editor.locator("select")).toHaveCount(0);
  await expect(editor.getByRole("combobox", { name: "Repository" })).toBeVisible();
  await expect(editor.getByTestId("routine-save")).toBeInViewport();
  await editor.getByLabel("Name").fill("Daily CI triage");
  await editor.getByLabel("Brief").fill("Look at main's failing jobs and open one PR per failure.");
  await editor.getByLabel("Time").fill("9:30 PM");
  await editor.getByTestId("routine-save").click();
  await expect(editor.getByRole("alert")).toHaveText("Give the time as HH:MM, on a 24-hour clock.");
  await editor.getByLabel("Time").fill("21:30");
  await editor.getByTestId("routine-save").click();
  await expect(editor).toHaveCount(0);

  const row = section.getByTestId("routine-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("routine-summary")).toHaveText(/^Every day at 21:30 · Worker in /);
  await expect(row.getByTestId("routine-runs")).toContainText("21:30");
  await expect(row.getByTestId("routine-runs")).not.toContainText(/AM|PM/);
  const [saved] = await routinesOf(page, workspaceId);
  expect(saved).toMatchObject({
    name: "Daily CI triage",
    schedule: { every: "day", at: "21:30" },
  });
  // The charter's write path gave it an id; it isn't off and goes to a worker.
  expect(saved?.id).toBeTruthy();
  expect(saved?.off).toBeUndefined();
  expect(saved?.target).toBeUndefined();

  // Edit it into a weekly orchestrator routine.
  await row.getByRole("button", { name: "Routine Daily CI triage actions" }).click();
  await page.getByRole("menuitem", { name: "Edit…" }).click();
  await editor.getByRole("radio", { name: "Weekly" }).click();
  await expect(editor.getByRole("heading", { name: "Edit routine" })).toBeVisible();
  await editor.getByRole("combobox", { name: "Day" }).click();
  await page.getByRole("option", { name: "Friday" }).click();
  await editor.getByLabel("Time").fill("16:00");
  await editor.getByRole("radio", { name: "Wakes the orchestrator" }).click();
  await editor.getByTestId("routine-save").click();
  await expect(row.getByTestId("routine-summary")).toHaveText(
    "Fridays at 16:00 · Wakes the orchestrator",
  );
  const [edited] = await routinesOf(page, workspaceId);
  expect(edited).toMatchObject({
    id: saved?.id,
    schedule: { every: "week", day: 5, at: "16:00" },
    target: "orchestrator",
  });
  await section.screenshot({ path: test.info().outputPath("routines-section.png") });
});

test("turns a routine off and on, runs it now, and removes it after asking", async ({ page }) => {
  const workspaceId = await openWorkspace(page);
  await setRoutines(page, workspaceId, [
    {
      name: "Nightly flake sweep",
      brief: "Rerun the flaky suites and report what still fails.",
      schedule: { every: "hours", hours: 12 },
    },
  ]);
  const section = page.getByTestId("workspace-routines");
  const row = section.getByTestId("routine-row");
  await expect(row.getByTestId("routine-summary")).toHaveText(/^Every 12 hours · Worker in /);
  await expect(row.getByTestId("routine-runs")).toContainText("Next ");

  const toggle = row.getByRole("switch", { name: "Run Nightly flake sweep on its schedule" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(row.getByTestId("routine-runs")).toHaveText("Off");
  expect((await routinesOf(page, workspaceId))[0]?.off).toBe(true);
  await toggle.click();
  await expect(row.getByTestId("routine-runs")).toContainText("Next ");

  await row.getByTestId("routine-run-now").click();
  await expect(row.getByTestId("routine-runs")).toContainText("(Run now), started a worker");

  await row.getByRole("button", { name: "Routine Nightly flake sweep actions" }).click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  await expect(row.getByRole("alertdialog")).toContainText("Workers it started carry on.");
  await row.getByTestId("routine-remove-confirm").click();
  await expect(section.getByTestId("routines-empty")).toBeVisible();
  expect(await routinesOf(page, workspaceId)).toEqual([]);
});

test("a paused workspace's routines can't be run now", async ({ page }) => {
  const workspaceId = await openWorkspace(page);
  await setRoutines(
    page,
    workspaceId,
    [
      {
        name: "Weekly dependency check",
        brief: "Check for outdated dependencies.",
        target: "orchestrator",
        schedule: { every: "week", day: 1, at: "08:00" },
      },
    ],
    true,
  );
  const row = page.getByTestId("workspace-routines").getByTestId("routine-row");
  await expect(row.getByTestId("routine-run-now")).toBeDisabled();
});

test("a worker a routine started says so under its header", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await threadRow(page, "t-flaky").waitFor();
  const made = await page.evaluate(async () => {
    const board = await window.gramMock!.simulateOrchestration("board");
    window.gramMock!.simulateRoutineWorker(board.briefed, {
      id: "routine-ci",
      name: "Daily CI triage",
    });
    return board;
  });
  await openOrchestrator(page, made.orchestratorThreadId);
  await threadRow(page, made.briefed).click();
  const line = page.getByTestId("worker-banner-routine");
  await expect(line).toHaveText(/From routine Daily CI triage/);
  // Any other worker says nothing of routines.
  await threadRow(page, made.working).click();
  await expect(page.getByRole("heading", { name: /^Worker: / })).toBeVisible();
  await expect(page.getByTestId("worker-banner-routine")).toHaveCount(0);
  await threadRow(page, made.briefed).click();
  await line.getByTestId("worker-banner-routines").click();
  await expect(page).toHaveURL(/\/settings\/routines/);
  await expect(page.getByTestId("workspace-routines").first()).toBeVisible();
});

test("Routines is a place of its own, reached from the palette and from Settings search", async ({
  page,
}) => {
  const workspaceId = await openWorkspace(page);
  await setRoutines(page, workspaceId, [
    {
      name: "Weekly dependency check",
      brief: "Check for outdated dependencies.",
      target: "orchestrator",
      schedule: { every: "week", day: 1, at: "08:00" },
    },
  ]);

  // From the palette's Go to.
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill("routines");
  await palette.getByRole("option", { name: "Routines", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/routines$/);
  // Each workspace is a group of its own, under its name.
  const group = page.getByRole("region", { name: "Routines fixture" });
  await expect(group.getByTestId("routine-row")).toHaveText(/Weekly dependency check/);
  await expect(group).toContainText("1 routine");

  // From Settings search, which finds the page by what it is for.
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "General", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Search settings" }).fill("cron");
  const found = page.locator('[data-settings-page="/settings/routines"]');
  await found.getByRole("link", { name: /Routines/ }).click();
  await expect(page).toHaveURL(/\/settings\/routines/);

  // Its editor is the same dialog, named for the workspace it runs in.
  await group.getByRole("button", { name: "Routine Weekly dependency check actions" }).click();
  await page.getByRole("menuitem", { name: "Edit…" }).click();
  const editor = page.getByTestId("routine-editor");
  await expect(editor.getByTestId("routine-editor-workspace")).toHaveText("Routines fixture");
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toHaveCount(0);
});
