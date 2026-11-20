import type { PlanStep, ThreadPlan } from "@gram/contracts";
import { expect, test, type Page } from "@playwright/test";

import { openOrchestrator } from "./thread-row";

// A worker's head in the right pane, on the mock's board scenario: its step and its repositories
// on one line under its state, each said once, with the plan and the multi-repo caveat a click or
// a key away; and the main view keeps its plan strip and its note.

const step = (id: string, text: string, status: PlanStep["status"]): PlanStep => ({
  id: id as PlanStep["id"],
  text,
  status,
  source: "agent",
});

const PLAN: Omit<ThreadPlan, "updatedAt"> = {
  goal: "Mail trigger endpoint across api, web and docs",
  basis: "spec",
  updatedBy: "helper",
  steps: [
    step("s1", "Endpoint and schema in api", "done"),
    step("s2", "Client in web", "done"),
    step("s3", "Focused checks", "doing"),
    step("s4", "Docs page", "todo"),
  ],
};

/** The board, a plan on its multi-repo worker, and that worker or `pick` open in the pane. */
const openWorker = async (page: Page, pick: "inReview" | "working" = "inReview") => {
  await page.goto("/t/t-flaky");
  await page.getByTestId("overview-sidebar").waitFor();
  const made = await page.evaluate(async (plan) => {
    const mock = window.gramMock;
    if (!mock) throw new Error("the mock API isn't on this page");
    const board = await mock.simulateOrchestration("board");
    mock.simulatePlan(board.inReview, { ...plan, updatedAt: Date.now() });
    mock.simulateStatus(board.inReview, "running");
    return board;
  }, PLAN);
  await openOrchestrator(page, made.orchestratorThreadId);
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await page
    .locator(`[data-testid="workers-panel-row"][data-thread-id="${made[pick]}"]`)
    .first()
    .click();
  await expect(pane(page)).toHaveAttribute("data-thread-id", made[pick]);
  return made;
};

const pane = (page: Page) => page.getByTestId("beside-dock");

test("the head says the step once, beside its count, and the rows under the tools are gone", async ({
  page,
}) => {
  await openWorker(page);
  const line = pane(page).getByTestId("beside-plan-line");
  await expect(line.getByTestId("beside-plan-step")).toHaveText("Focused checks");
  await expect(line.getByTestId("beside-plan-count")).toHaveText("Step 3 of 4");
  // Progress is said once: not again on the state line, nor in a strip under the tools.
  await expect(pane(page).getByTestId("beside-state")).not.toContainText(/Step \d/);
  await expect(pane(page).getByTestId("plan-strip")).toHaveCount(0);
  await expect(pane(page).getByTestId("worker-banner-repos")).toHaveCount(0);
});

test("the plan and the multi-repo caveat open by the keys, and Esc closes them without leaving the worker", async ({
  page,
}) => {
  const made = await openWorker(page);
  // The plan: Enter on the step opens every step; Esc closes it and the worker stays.
  const plan = pane(page).getByTestId("beside-plan");
  await plan.focus();
  await page.keyboard.press("Enter");
  const popup = page.getByTestId("beside-plan-popup");
  await expect(popup.getByTestId("plan-step")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(pane(page)).toHaveAttribute("data-thread-id", made.inReview);

  // The repositories, always shown at the line's end, short; Enter says all and what follows the
  // first one only.
  const repos = pane(page).getByTestId("beside-repos");
  await expect(repos).toHaveText(/^api\s*\+2$/);
  await repos.focus();
  await page.keyboard.press("Enter");
  const caveat = page.getByTestId("beside-repos-popup");
  await expect(caveat).toContainText("api, web and docs");
  await expect(caveat).toContainText("follow api only");
  await page.keyboard.press("Escape");
  await expect(caveat).toHaveCount(0);
  await expect(pane(page)).toHaveAttribute("data-thread-id", made.inReview);
  // A click opens it too.
  await repos.click();
  await expect(caveat).toBeVisible();
});

test("a worker in one repository names it, with nothing to open", async ({ page }) => {
  await openWorker(page, "working");
  const repos = pane(page).getByTestId("beside-repos");
  await expect(repos).toHaveText("api");
  await expect(repos).not.toHaveRole("button");
});

test("the same worker in the main view keeps its plan strip and its multi-repo note", async ({
  page,
}) => {
  await openWorker(page);
  await pane(page).getByTestId("beside-open").click();
  await expect(page.getByTestId("plan-strip")).toBeVisible();
  await expect(page.getByTestId("worker-banner-repos")).toContainText("api, web, docs");
});
