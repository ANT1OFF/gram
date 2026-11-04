import { expect, type Page } from "@playwright/test";

import { openOrchestrator, threadRow } from "../e2e/thread-row";
import { elapse, FLAKY_DONE_MS, SHOTS, seedMockSettings, type Shot } from "./shots";
import { TOUR } from "./tour";

const from = (shots: readonly Shot[], name: string): Shot["open"] => {
  const shot = shots.find((candidate) => candidate.name === name);
  if (!shot) throw new Error(`flows: missing shot ${name}`);
  return shot.open;
};
const shot = (name: string) => from(SHOTS, name);
const tour = (name: string) => from(TOUR, name);

const openApproval = shot("thread");
const retryableError = async (page: Page) => {
  await page.goto("/t/t-docs");
  await page.getByLabel("Message", { exact: true }).waitFor();
  await page.evaluate(() =>
    window.gramMock!.simulateTurnError(
      "t-docs" as never,
      {
        kind: "rateLimit",
        httpStatus: 429,
        retryable: true,
        text: "The gateway is rate limiting requests (HTTP 429). Try again in a moment.",
      },
      "Run the e2e suite",
    ),
  );
  await expect(page.getByTestId("agent-error").last()).toBeVisible();
};

/** From the Needs you pill, a forwarded question's row: its ask turned to in the orchestrator's dock. */
const questionInDock = async (page: Page) => {
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateWorkerQuestions());
  await page.getByTestId("overview-needs-you").click();
  await page
    .getByTestId("needs-you-popover")
    .getByTestId("needs-you-item")
    .filter({ hasText: "Should the retry queue drop a job" })
    .getByTestId("needs-you-open")
    .click();
  const item = page.locator(
    `[data-testid="ask-item"][data-ask-key="worker-question:${made.workspaceId}:WQ1"]`,
  );
  await expect(item).toBeFocused();
  return item;
};

const steps: readonly Shot[] = [
  {
    name: "new-menu",
    title: "Start: the sidebar's New opens the one New form",
    open: async (page) => {
      await openApproval(page);
      await page.getByRole("button", { name: "New", exact: true }).click();
      await expect(page.getByRole("menu").or(page.getByRole("radiogroup").first())).toBeVisible();
    },
  },
  {
    name: "new-task",
    title: "Start: direct worker task form with a drafted goal",
    open: async (page) => {
      await page.goto("/new-task?way=direct");
      await page.getByLabel("What needs doing").fill("Add retry coverage for the queue consumer.");
    },
  },
  {
    name: "task-started",
    title: "Start: submit the task and land on its new thread",
    open: async (page) => {
      await page.goto("/new-task?way=direct");
      await page.getByLabel("What needs doing").fill("Add retry coverage for the queue consumer.");
      await page.getByRole("button", { name: /Start (workspace and )?worker/ }).click();
      await expect(page).toHaveURL(/\/t\//);
      await page.getByLabel("Message", { exact: true }).waitFor();
      await page.getByTestId("message-user").first().waitFor();
    },
  },
  { name: "new-thread", title: "Start: one-off thread form", open: shot("new-thread") },
  {
    name: "needs-you",
    title: "Find what needs me: global Needs you popover",
    open: tour("08-needs-you"),
  },
  { name: "approval", title: "Answer: pending approval and scope choices", open: openApproval },
  {
    name: "approval-allowed",
    title: "Answer: allow the scripted approval and let the turn finish",
    open: async (page) => {
      await openApproval(page);
      await elapse(page, FLAKY_DONE_MS);
      await page.getByTestId("approval-allow").click();
      await expect(page.getByTestId("pane-status")).toHaveText("Idle");
      await expect(page.getByTestId("turn-fold")).toContainText("Worked for 1m 12s");
    },
  },
  {
    name: "question",
    title: "Answer: forwarded question with its choices open",
    open: tour("09-questions"),
  },
  {
    name: "question-answered",
    title: "Answer: send the selected choice to the worker",
    open: async (page) => {
      await tour("09-questions")(page);
      const question = page.locator('[data-testid="rail-waiting"] [data-question="WQ1"]');
      await question.getByRole("radio", { name: /^Keep for replay/ }).click();
      await question.getByRole("button", { name: "Send to the worker" }).click();
      await expect(question).toHaveCount(0);
    },
  },
  {
    name: "question-dock",
    title: "Answer: the Needs you row opens the forwarded question in the Asks dock",
    open: async (page) => {
      await questionInDock(page);
    },
  },
  {
    name: "question-dock-answered",
    title: "Answer: one choice in the dock sends it to the worker, with Undo",
    open: async (page) => {
      const item = await questionInDock(page);
      await item.getByTestId("ask-option").filter({ hasText: "Keep for replay" }).click();
      await expect(page.getByTestId("ask-undo-line")).toContainText("Keep for replay");
    },
  },
  {
    name: "question-sheet",
    title: "Answer: a long question opens in the ask sheet, its answer row in sight",
    open: async (page) => {
      await page.goto("/t/t-flaky");
      await threadRow(page, "t-flaky").waitFor();
      const made = await page.evaluate(() => window.gramMock!.simulateWorkerQuestions());
      await openOrchestrator(page, made.orchestratorThreadId);
      await page
        .getByRole("radiogroup", { name: "View" })
        .getByRole("radio", { name: /^Board\b/ })
        .click();
      await page.evaluate(async (workspaceId) => {
        const mock = window.gramMock!;
        const ledger = await mock.orchestratorLedger(workspaceId as never);
        const question = ledger.questions?.find((each) => each.id === "WQ1");
        if (question === undefined) throw new Error("no WQ1");
        await mock.simulateWorkerQuestion({
          ...question,
          context: `${question.context ?? ""} The relay retries on its own schedule, so a job kept for replay may already have been retried by the time someone looks. A replay button on the jobs page would need its own permission, and the queue keeps jobs for 30 days.`,
          options: [
            ...(question.options ?? []),
            { label: "Park it", description: "Hold the job until someone looks." },
            { label: "Ask the sender", description: "Mail the sender a link to retry." },
            { label: "Retry with backoff", description: "Five tries, then report it." },
          ],
        });
      }, made.workspaceId);
      await page.getByTestId("rail-waiting-chip").click();
      const card = page.locator('[data-testid="rail-waiting"] [data-question="WQ1"]');
      // The longer question has reached the band before its Answer is pressed.
      await expect(card).toContainText("30 days");
      await card.getByTestId("question-answer").click();
      await expect(page.getByTestId("ask-sheet-answer-row")).toBeInViewport();
    },
  },
  {
    name: "diff",
    title: "Review: changed files and diff beside the thread",
    open: async (page) => {
      await openApproval(page);
      await page
        .locator('[data-testid="diff-file"][data-path="src/retry.test.ts"]')
        .getByRole("button")
        .first()
        .click();
      await expect(page.getByTestId("right-panel")).toContainText("useFakeTimers");
    },
  },
  {
    name: "pr",
    title: "Review: PR details, checks and review controls",
    open: async (page) => {
      await openApproval(page);
      await page.getByTestId("right-panel").getByRole("tab", { name: "PR", exact: true }).click();
      await expect(page.getByTestId("right-panel")).toContainText("Checks");
    },
  },
  {
    name: "jump-search",
    title: "Jump: ⌘K search for another thread",
    open: async (page) => {
      await shot("palette-go-to")(page);
      await page.getByTestId("command-palette").getByRole("combobox").fill("Bump dependencies");
      await expect(page.getByRole("option", { name: /Bump dependencies/ })).toBeVisible();
    },
  },
  {
    name: "jumped",
    title: "Jump: select the matching thread",
    open: async (page) => {
      await shot("palette-go-to")(page);
      await page.getByTestId("command-palette").getByRole("combobox").fill("Bump dependencies");
      await page.getByRole("option", { name: /Bump dependencies/ }).click();
      await expect(page).toHaveURL(/\/t\/t-deps$/);
    },
  },
  {
    name: "workspaces",
    title: "Switch: workspace switcher and solo threads entry",
    open: shot("views-switcher"),
  },
  { name: "model", title: "Change: composer model picker", open: tour("05-composer-model") },
  {
    name: "mode",
    title: "Change: composer permission mode picker",
    open: tour("06-composer-mode"),
  },
  {
    name: "effort",
    title: "Change: reasoning effort picker",
    open: async (page) => {
      await seedMockSettings(page, { panel: { open: false } });
      await page.goto("/t/t-deps");
      await page.getByLabel("Message", { exact: true }).focus();
      await page.keyboard.press("ControlOrMeta+Shift+KeyE");
      await expect(page.getByRole("option").first()).toBeVisible();
    },
  },
  { name: "done", title: "Find old work: Done grouped by date", open: tour("10-done-by-date") },
  {
    name: "settings",
    title: "Settings: open General from the keyboard",
    open: async (page) => {
      await page.goto("/t/t-deps");
      await page.getByLabel("Message", { exact: true }).waitFor();
      await page.keyboard.press("ControlOrMeta+,");
      await expect(page.getByTestId("general-settings")).toBeVisible();
    },
  },
  {
    name: "settings-saved",
    title: "Settings: change Default folder and confirm it survives reload",
    open: async (page) => {
      await page.goto("/settings/general");
      const folder = page.getByLabel("Default folder", { exact: true });
      await folder.fill("~/work/sandbox");
      await folder.press("Enter");
      await page.reload();
      await expect(folder).toHaveValue("~/work/sandbox");
    },
  },
  {
    name: "stop-running",
    title: "Stop: running turn with its Stop control",
    open: shot("send-button-running"),
  },
  {
    name: "stopped",
    title: "Stop: interrupt the running turn",
    open: async (page) => {
      await shot("send-button-running")(page);
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
    },
  },
  {
    name: "usage",
    title: "Usage: subscription limits and reset times",
    open: shot("titlebar-usage"),
  },
  { name: "error", title: "Recover: retryable rate-limit error with Retry", open: retryableError },
  {
    name: "retried",
    title: "Recover: Retry sends the failed prompt again",
    open: async (page) => {
      await retryableError(page);
      await page.getByTestId("agent-error").last().getByRole("button", { name: "Retry" }).click();
      await expect(page.getByTestId("message-user").last()).toContainText("Run the e2e suite");
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
    },
  },
  {
    name: "effort-changed",
    title: "Change: pick Extra high effort and see the gauge take it",
    open: async (page) => {
      await seedMockSettings(page, { panel: { open: false } });
      await page.goto("/t/t-deps");
      await page.getByLabel("Message", { exact: true }).focus();
      await page.keyboard.press("ControlOrMeta+Shift+KeyE");
      await page.getByRole("option", { name: "Extra high effort" }).click();
      await expect(page.getByRole("combobox", { name: "Effort: Extra high effort" })).toBeVisible();
      await expect(page.getByTestId("effort-gauge")).toHaveAttribute("data-level", "xhigh");
    },
  },
];

export const FLOW_SHOTS: readonly Shot[] = steps.map((step, index) => ({
  name: `${String(index + 1).padStart(2, "0")}-${step.name}`,
  title: step.title,
  open: async (page) => {
    await step.open(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.mouse.move(1438, 898);
  },
}));
