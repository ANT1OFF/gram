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

const routinesOf = (page: Page, workspaceId: string) =>
  page.evaluate((id) => window.gramMock!.listRoutines(id as never), workspaceId);

test("adds a routine, refuses a 12-hour time, and saves its schedule and target", async ({
  page,
}) => {
  const workspaceId = await openWorkspace(page);
  const section = page.getByTestId("workspace-routines");
  await expect(section.getByTestId("routines-empty")).toHaveText("No routines yet");

  await page.getByTestId("routine-add").click();
  const editor = section.getByTestId("routine-editor");
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
  await expect(row.getByTestId("routine-summary")).toHaveText(/^Daily at 21:30 · Worker in /);
  await expect(row.getByTestId("routine-runs")).toContainText("21:30");
  await expect(row.getByTestId("routine-runs")).not.toContainText(/AM|PM/);
  const [saved] = await routinesOf(page, workspaceId);
  expect(saved).toMatchObject({
    name: "Daily CI triage",
    enabled: true,
    schedule: { kind: "daily", time: "21:30" },
    target: { kind: "worker" },
  });

  // Edit it into a weekly orchestrator routine.
  await row.getByRole("button", { name: "Routine Daily CI triage actions" }).click();
  await page.getByRole("menuitem", { name: "Edit…" }).click();
  await editor.getByRole("radio", { name: "Weekly" }).click();
  await editor.getByLabel("Day").selectOption("fri");
  await editor.getByLabel("Time").fill("16:00");
  await editor.getByRole("radio", { name: "Wakes the orchestrator" }).click();
  await editor.getByTestId("routine-save").click();
  await expect(row.getByTestId("routine-summary")).toHaveText(
    "Fridays at 16:00 · Wakes the orchestrator",
  );
  expect((await routinesOf(page, workspaceId))[0]).toMatchObject({
    schedule: { kind: "weekly", day: "fri", time: "16:00" },
    target: { kind: "orchestrator" },
  });
  await section.screenshot({ path: test.info().outputPath("routines-section.png") });
});

test("turns a routine off and on, runs it now, and removes it after asking", async ({ page }) => {
  const workspaceId = await openWorkspace(page);
  await page.evaluate(async (id) => {
    const api = window.gramMock!;
    const project = (await api.listProjects())[0]!;
    await api.createRoutine(id as never, {
      name: "Nightly flake sweep",
      brief: "Rerun the flaky suites and report what still fails.",
      target: { kind: "worker", projectId: project.id },
      schedule: { kind: "interval", hours: 12 },
    });
  }, workspaceId);
  const section = page.getByTestId("workspace-routines");
  const row = section.getByTestId("routine-row");
  await expect(row.getByTestId("routine-summary")).toHaveText(/^Every 12 hours · Worker in /);
  await expect(row.getByTestId("routine-runs")).toContainText("Next ");

  const toggle = row.getByRole("switch", { name: "Run Nightly flake sweep on its schedule" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(row.getByTestId("routine-runs")).toHaveText("Off");
  expect((await routinesOf(page, workspaceId))[0]?.enabled).toBe(false);
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
  await page.evaluate(async (id) => {
    const api = window.gramMock!;
    await api.createRoutine(id as never, {
      name: "Weekly dependency check",
      brief: "Check for outdated dependencies.",
      target: { kind: "orchestrator" },
      schedule: { kind: "weekly", day: "mon", time: "08:00" },
    });
    await api.setOrchestratorPaused(id as never, true);
  }, workspaceId);
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
  await expect(page.getByTestId("workspace-routines")).toBeVisible();
});
