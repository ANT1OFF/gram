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
  // t-docs plays its README turn on load; the failed turn follows it, as the server would. A base
  // from before the hook just doesn't wait.
  await page.evaluate(() => window.gramMock!.turnEnded?.("t-docs" as never));
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

/** From the Needs you pill, the refund worker's question, shown in the Inbox's detail pane. */
const questionInDock = async (page: Page) => {
  await openRealisticOrchestrator(page);
  await page.getByTestId("overview-needs-you").click();
  await page.locator('[data-testid="inbox"], [data-testid="needs-you-popover"]').first().waitFor();
  // On a base from before the Inbox, the popover's row opens the ask in the dock.
  if ((await page.getByTestId("needs-you-popover").count()) > 0) {
    await page
      .getByTestId("needs-you-item")
      .filter({ hasText: "A refund webhook that keeps failing" })
      .getByTestId("needs-you-open")
      .click();
    const docked = page.getByTestId("ask-item").filter({ hasText: "A refund webhook" });
    await expect(docked).toBeFocused();
    return docked;
  }
  await page
    .getByTestId("inbox-item")
    .filter({ hasText: "A refund webhook that keeps failing" })
    .click();
  const item = page.getByTestId("inbox-detail").getByTestId("ask-item");
  await expect(item).toContainText("A refund webhook");
  return item;
};

/** The billing-api orchestrator, its header's Waiting on you, open on its one ask. */
const questionInBilling = async (page: Page) => {
  const made = await openRealistic(page);
  const orchestrator = await page.evaluate(
    async (id) =>
      (await window.gramMock!.listWorkspaces()).find((w) => w.workspace.id === id)!.workspace
        .orchestratorThreadId!,
    made.askingWorkspaceId,
  );
  await openOrchestrator(page, orchestrator);
  // On a base from before the Inbox, the ask is in the orchestrator's dock.
  const line = page.getByTestId("status-waiting");
  await line.or(page.getByTestId("ask-stack")).first().waitFor();
  if ((await line.count()) > 0) await line.click();
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
    title: "Start: submit the task and land on its new thread, its agent still starting",
    open: async (page) => {
      // Held while its session opens, so the frame shows the new worker as it starts.
      await page.addInitScript(() => {
        window.gramMockHoldGates = true;
        window.gramMockHoldWorkerStart = true;
      });
      await page.goto("/new-task?way=direct");
      await page.getByLabel("What needs doing").fill("Add retry coverage for the queue consumer.");
      await page.getByRole("button", { name: /Start (workspace and )?worker/ }).click();
      await expect(page).toHaveURL(/\/t\//);
      await page.getByLabel("Message", { exact: true }).waitFor();
      await page.getByTestId("message-user").first().waitFor();
      await page.getByTestId("overview-worker-starting").first().waitFor();
    },
  },
  {
    name: "new-task-again",
    title: "Start again: the next worker's form folds to the brief and the remembered place",
    open: async (page) => {
      await page.goto("/new-task?way=direct");
      await page.getByLabel("What needs doing").fill("Add retry coverage for the queue consumer.");
      await page.getByRole("button", { name: /Start (workspace and )?worker/ }).click();
      await expect(page).toHaveURL(/\/t\//);
      await page.getByLabel("Message", { exact: true }).waitFor();
      // The next one, by its shortcut, in the same session: the last target is remembered.
      await page.keyboard.press("ControlOrMeta+Alt+n");
      await page.getByLabel("What needs doing").waitFor();
      await page.getByLabel("What needs doing").fill("Cover the dead-letter path too.");
    },
  },
  { name: "new-thread", title: "Start: one-off thread form", open: shot("new-thread") },
  {
    name: "first-run-search",
    title: "First run: a long repository list gets a focused search",
    open: async (page) => {
      // More repositories than the list shows, as a folder of many checkouts gives (synthetic):
      // added to the mock's list as the page boots, before the first run asks for it.
      await page.addInitScript(() => {
        const more = ["billing", "mobile", "design-system", "data-pipeline", "status-page"];
        Object.defineProperty(window, "gramMock", {
          configurable: true,
          get: () => undefined,
          set(mock: NonNullable<Window["gramMock"]>) {
            const listed = mock.listRepositories.bind(mock);
            mock.listRepositories = async () => {
              const { repos } = await listed();
              return {
                repos: [
                  ...repos,
                  ...more.map((name) => ({ name, root: `/Users/dev/src/${name}` })),
                ],
              };
            };
            Object.defineProperty(window, "gramMock", {
              configurable: true,
              writable: true,
              value: mock,
            });
          },
        });
      });
      await tour("01-first-run")(page);
      const search = page.getByRole("searchbox", { name: "Find a repository" });
      await search.waitFor();
      await search.fill("bill");
      await expect(page.getByTestId("welcome-open")).toContainText("Open billing");
    },
  },
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
    title:
      "Answer: a worker's question in the Inbox, from its orchestrator's header; a choice is picked",
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
        page
          .locator('[data-testid="inbox-item"], [data-testid="ask-item"]')
          .filter({ hasText: "A refund webhook" }),
      ).toHaveCount(0);
      await page.waitForTimeout(600);
    },
  },
  {
    name: "question-dock",
    title: "Answer: the Needs you pill opens the Inbox on the forwarded question",
    open: async (page) => {
      await questionInDock(page);
    },
  },
  {
    name: "question-dock-answered",
    title: "Answer: a choice picked in the Inbox, then Send answer, sends it to the worker",
    open: async (page) => {
      const item = await questionInDock(page);
      await item.getByTestId("ask-option").filter({ hasText: "72 hours" }).click();
      await item.getByTestId("ask-send").click();
      await expect(
        page
          .locator('[data-testid="inbox-item"], [data-testid="ask-item"]')
          .filter({ hasText: "A refund webhook" }),
      ).toHaveCount(0);
      await page.waitForTimeout(600);
    },
  },
  {
    name: "stress-question-sheet",
    title:
      "Stress test: a long question's own card in the Inbox, among many asks, its answer row in sight",
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
      await page
        .locator(
          `[data-testid="inbox-item"][data-key="ask:worker-question:${made.workspaceId}:WQ1"]`,
        )
        .click();
      await expect(page.getByTestId("inbox-detail")).toContainText("30 days");
      await page.getByTestId("inbox-read-full").click();
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
    name: "settings-dirty",
    title: "Settings: a typed folder not saved yet says Enter to save · Esc to cancel",
    open: async (page) => {
      await page.goto("/settings/general");
      await page.getByLabel("Default folder", { exact: true }).fill("~/work/sandbox");
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
      await expect(page.getByRole("combobox", { name: "Effort: Extra high" })).toBeVisible();
      await expect(page.getByTestId("effort-gauge")).toHaveAttribute("data-level", "xhigh");
      // Said in words for a moment, beside the glyph that changed.
      await expect(page.getByText("Effort set to Extra high")).toBeVisible();
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
      await expect(page.getByTestId("agent-error-attempt-number")).toContainText(
        "attempt 2 of 2 · needs action",
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
  {
    name: "approval-always",
    title: "Answer: Always allow… shows the exact rule and how far it reaches before saving",
    open: async (page) => {
      await openApproval(page);
      const card = page.getByTestId("approval-card");
      await card.getByTestId("approval-always").click();
      await expect(card.getByTestId("approval-always-rule")).toContainText("Bash(");
    },
  },
  {
    name: "limit-reset",
    title: "Recover: a spent limit names its reset, Try again at HH:MM with Retry then and Usage",
    open: async (page) => {
      await page.goto("/t/t-docs");
      await page.getByLabel("Message", { exact: true }).waitFor();
      await page.evaluate(() => {
        window.gramMock!.simulateUsageLimit({
          agent: "claude",
          window: "five_hour",
          utilization: 1,
          status: "rejected",
          resetsAt: Math.ceil((Date.now() + 75 * 60_000) / 900_000) * 900_000,
        });
        return window.gramMock!.simulateTurnError(
          "t-docs" as never,
          {
            kind: "rateLimit",
            httpStatus: 429,
            retryable: false,
            text: "The usage limit is reached (HTTP 429). It resets on the provider's schedule.",
          },
          "Run the e2e suite",
        );
      });
      await expect(page.getByTestId("agent-error-retry-time")).toContainText(/Try again at/);
    },
  },
  {
    name: "stop-key",
    title: "Stop: while you're in the composer, its key shows beside it",
    open: async (page) => {
      await shot("send-button-running")(page);
      await page.getByLabel("Message", { exact: true }).focus();
      await expect(page.getByTestId("stop-key")).toHaveCSS("opacity", "1");
    },
  },
  {
    name: "old-thread",
    title: "Find old work: a finished worker whose conversation isn't on this computer",
    open: async (page) => {
      await page.goto("/t/t-docs");
      await page.getByRole("button", { name: /^Release notes for 0.9, Gram, merged/ }).click();
      await expect(
        page.getByRole("heading", { name: "Worker: Release notes for 0.9", exact: true }),
      ).toBeVisible();
    },
  },
  {
    name: "first-run",
    title: "First run: no workspace yet, the start card with its steps and agent",
    open: tour("01-first-run"),
  },
];

/**
 * Numbered steps at `SET_SIZE`, over the realistic scenario but for the `stress-` steps, which
 * stage the fixture scenes that pile every state on at once, and the `first-run` ones.
 */
export const FLOW_SHOTS: readonly Shot[] = steps.map((step, index) => ({
  name: `${String(index + 1).padStart(2, "0")}-${step.name}`,
  title: step.title,
  open: async (page) => {
    // A first run has no workspaces yet, which the realistic scenario would add.
    if (!step.name.startsWith("stress-") && !step.name.startsWith("first-run"))
      await stageRealistic(page);
    await step.open(page);
    await page.setViewportSize(SET_SIZE);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.mouse.move(SET_SIZE.width - 2, SET_SIZE.height - 2);
  },
}));
