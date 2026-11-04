import { expect, type Page } from "@playwright/test";

import { openOrchestrator, threadRow } from "../e2e/thread-row";
import { elapse, FLAKY_DONE_MS, SHOTS, seedMockSettings, type Shot } from "./shots";
import { openRealistic, openRealisticOrchestrator, SET_SIZE, TOUR, stageRealistic } from "./tour";

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

/** From the Needs you pill, the refund worker's question: its ask turned to in its orchestrator's dock. */
const questionInDock = async (page: Page) => {
  await openRealisticOrchestrator(page);
  await page.getByTestId("overview-needs-you").click();
  await page
    .getByTestId("needs-you-popover")
    .getByTestId("needs-you-item")
    .filter({ hasText: "A refund webhook that keeps failing" })
    .getByTestId("needs-you-open")
    .click();
  const item = page.getByTestId("ask-item").filter({ hasText: "A refund webhook" });
  await expect(item).toBeFocused();
  return item;
};

/** The billing-api orchestrator, its one ask in the Asks dock. */
const questionInBilling = async (page: Page) => {
  const made = await openRealistic(page);
  const orchestrator = await page.evaluate(
    async (id) =>
      (await window.gramMock!.listWorkspaces()).find((w) => w.workspace.id === id)!.workspace
        .orchestratorThreadId!,
    made.askingWorkspaceId,
  );
  await openOrchestrator(page, orchestrator);
  const item = page.getByTestId("ask-item").filter({ hasText: "A refund webhook" });
  await item.getByTestId("ask-option").first().waitFor();
  return item;
};

/** ⌘K over the realistic orchestrator, searching for a solo thread. */
const jumpSearch = async (page: Page) => {
  await openRealisticOrchestrator(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette").getByRole("combobox").fill("Bump dependencies");
  await expect(page.getByRole("option", { name: /Bump dependencies/ })).toBeVisible();
};

const steps: readonly Shot[] = [
  {
    name: "new-menu",
    title: "Start: the sidebar's New opens the one New form",
    open: async (page) => {
      await openApproval(page);
      await page.getByRole("button", { name: "New", exact: true }).click();
      await expect(
        page.getByRole("menu").or(page.getByRole("radiogroup", { name: "Who does it" })),
      ).toBeVisible();
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
    title: "Answer: a worker's question in its orchestrator's Asks dock; a choice is picked",
    open: async (page) => {
      const item = await questionInBilling(page);
      const option = item.getByTestId("ask-option").filter({ hasText: "72 hours" });
      await option.click();
      await expect(option).toHaveAttribute("aria-checked", "true");
    },
  },
  {
    name: "question-answered",
    title: "Answer: Send answer sends the picked choice to the worker",
    open: async (page) => {
      const item = await questionInBilling(page);
      await item.getByTestId("ask-option").filter({ hasText: "72 hours" }).click();
      await item.getByTestId("ask-send").click();
      await expect(
        page.getByTestId("ask-item").filter({ hasText: "A refund webhook" }),
      ).toHaveCount(0);
      await page.waitForTimeout(600);
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
    title: "Answer: a choice picked in the dock, then Send answer, sends it to the worker",
    open: async (page) => {
      const item = await questionInDock(page);
      await item.getByTestId("ask-option").filter({ hasText: "72 hours" }).click();
      await item.getByTestId("ask-send").click();
      await expect(
        page.getByTestId("ask-item").filter({ hasText: "A refund webhook" }),
      ).toHaveCount(0);
      await page.waitForTimeout(600);
    },
  },
  {
    name: "stress-question-sheet",
    title:
      "Stress test: a long question opens in the ask sheet among many asks; the dock folds to one row",
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
      await expect(page.getByTestId("rail-board").getByTestId("ask-stack")).toHaveAttribute(
        "data-compact",
        "true",
      );
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
    open: jumpSearch,
  },
  {
    name: "jumped",
    title: "Jump: select the matching thread",
    open: async (page) => {
      await jumpSearch(page);
      await page.getByRole("option", { name: /Bump dependencies/ }).click();
      await expect(page).toHaveURL(/\/t\/t-deps$/);
    },
  },
  {
    name: "workspaces",
    title: "Switch: workspace switcher and solo threads entry",
    open: async (page) => {
      await openRealisticOrchestrator(page);
      await page.getByTestId("workspace-switcher-button").click();
      await page.getByTestId("solo-threads").waitFor();
      await page.waitForTimeout(400);
    },
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
  { name: "history", title: "Find old work: History, every past chat", open: tour("10-history") },
  {
    name: "history-search",
    title: "Find old work: History searched by repo, on the Threads chip",
    open: async (page) => {
      await tour("10-history")(page);
      await page.getByTestId("history").getByRole("radio", { name: "Threads" }).click();
      await page.getByTestId("history-search").fill("api");
      await expect(page.getByTestId("history-row").first()).toBeVisible();
    },
  },
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
      // Stopped once the turn has said something, so the frame shows where it stopped.
      await page.getByText("I'll start by reading the test").waitFor();
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
      await expect(page.getByTestId("stop-receipt")).toContainText(/Stopped by you · \d\d:\d\d/);
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
      await expect(page.getByTestId("agent-error-retried")).toContainText(/Retried · \d\d:\d\d/);
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
  // Later additions go last, so the frames before them keep their numbers between rounds.
  {
    name: "retried-failed",
    title: "Recover: the retry failed too, and the newest attempt is the one that needs action",
    open: async (page) => {
      await retryableError(page);
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
      await expect(page.locator('[data-testid="agent-error"][data-state="retried"]')).toHaveCount(
        1,
      );
    },
  },
  {
    name: "stress-orchestrator-failing",
    title:
      "Stress test: failures first, the orchestrator's chat leads with a stopped worker and red CI",
    open: async (page) => {
      await page.goto("/t/t-flaky");
      await threadRow(page, "t-flaky").waitFor();
      const made = await page.evaluate(() => window.gramMock!.simulateFailures());
      await openOrchestrator(page, made.orchestratorThreadId);
      await expect(page.getByTestId("board-failure")).toHaveCount(2);
    },
  },
  {
    name: "review-focus",
    title: "Review: Focus review takes the window, the conversation a strip beside it",
    open: async (page) => {
      await openApproval(page);
      await page
        .locator('[data-testid="diff-file"][data-path="src/retry.test.ts"]')
        .getByRole("button")
        .first()
        .click();
      await page.getByTestId("right-panel").getByRole("button", { name: "Focus review" }).click();
      await expect(page.getByTestId("review-strip")).toBeVisible();
    },
  },
];

/**
 * Numbered steps at `SET_SIZE`, over the realistic scenario but for the `stress-` steps, which
 * stage the fixture scenes that pile every state on at once.
 */
export const FLOW_SHOTS: readonly Shot[] = steps.map((step, index) => ({
  name: `${String(index + 1).padStart(2, "0")}-${step.name}`,
  title: step.title,
  open: async (page) => {
    if (!step.name.startsWith("stress-")) await stageRealistic(page);
    await step.open(page);
    await page.setViewportSize(SET_SIZE);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.mouse.move(SET_SIZE.width - 2, SET_SIZE.height - 2);
  },
}));
