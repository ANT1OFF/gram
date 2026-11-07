import { expect, test, type Page } from "@playwright/test";

import { flakyAsked } from "./seed-asks";
import { seedTheme } from "./seed-theme";
import { openOrchestrator, threadRow } from "./thread-row";

// Workers' own questions (docs/design/worker-questions.md) where the user meets them: the Inbox,
// the overview's needs-you pill, the feature sheet and the worker's own thread.
// Mock state lives in memory, so every step after the seed navigates inside the app.

/** Where screenshots go when asked for (`WORKER_QUESTION_SHOTS=<dir>`); none otherwise. */
const SHOTS = process.env["WORKER_QUESTION_SHOTS"];

interface Seeded {
  readonly workspaceId: string;
  readonly orchestratorThreadId: string;
  readonly working: string;
  readonly ungrouped: string;
}

const start = async (page: Page): Promise<Seeded> => {
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  // Needs you counts t-flaky's approval too: up before any count is read.
  await flakyAsked(page);
  const made = await page.evaluate(() => window.gramMock!.simulateWorkerQuestions());
  await openOrchestrator(page, made.orchestratorThreadId);
  await page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  await expect(page.getByTestId("rail-board")).toBeVisible();
  return made;
};

const inbox = (page: Page) => page.getByTestId("inbox");
const detail = (page: Page) => page.getByTestId("inbox-detail");
/** The Inbox's row for a worker's question, by its id. */
const row = (page: Page, workspaceId: string, id: string) =>
  inbox(page).locator(
    `[data-testid="inbox-item"][data-key="ask:worker-question:${workspaceId}:${id}"]`,
  );
/** The Board's one way into the Inbox: its header's chip. */
const openInbox = async (page: Page) => {
  await page.getByTestId("rail-waiting-chip").click();
  await expect(inbox(page)).toBeVisible();
};
/** Opens the feature sheet of the feature question `id` was asked for. */
const openFeatureOf = async (page: Page, id: string) => {
  const feature = await page.evaluate(async (question) => {
    const [state] = await window.gramMock!.listWorkspaces();
    const ledger = await window.gramMock!.orchestratorLedger(state!.workspace.id);
    return ledger.questions?.find((each) => each.id === question)?.feature;
  }, id);
  await page
    .getByTestId("rail-board")
    .locator(`[data-testid="rail-row"][data-feature="${feature}"]`)
    .getByTestId("rail-feature")
    .click();
};
const needsYou = (page: Page) => page.getByTestId("overview-needs-you");
const countOf = async (page: Page) => Number(await needsYou(page).getAttribute("data-count"));

const stageOf = (page: Page, workspaceId: string, id: string) =>
  page.evaluate(
    async ([workspace, question]) =>
      (await window.gramMock!.orchestratorLedger(workspace as never)).questions?.find(
        (each) => each.id === question,
      ),
    [workspaceId, id] as const,
  );

test("the Inbox lists forwarded questions; one is answered there, another dismissed with a reason", async ({
  page,
}) => {
  const made = await start(page);
  // The pill counts them with everything else that needs the user.
  const before = await countOf(page);
  expect(before).toBeGreaterThanOrEqual(2);
  await openInbox(page);

  // The two forwarded to the user; the one still in triage and the closed ones aren't here.
  await expect(row(page, made.workspaceId, "WQ1")).toHaveCount(1);
  await expect(row(page, made.workspaceId, "WQ2")).toHaveCount(1);
  await expect(row(page, made.workspaceId, "WQ3")).toHaveCount(0);
  await row(page, made.workspaceId, "WQ1").click();
  await expect(detail(page)).toContainText(
    "Should the retry queue drop a job after three attempts, or keep it for a manual replay?",
  );
  // Picked, then sent: it leaves the Inbox and goes straight to the worker.
  await detail(page).getByTestId("ask-option").filter({ hasText: "Keep for replay" }).click();
  await expect(row(page, made.workspaceId, "WQ1")).toHaveCount(1);
  await detail(page).getByTestId("ask-send").click();
  await expect(row(page, made.workspaceId, "WQ1")).toHaveCount(0);
  await expect.poll(() => countOf(page)).toBe(before - 1);
  // Sent once the undo window is past.
  await expect
    .poll(() => stageOf(page, made.workspaceId, "WQ1"), { timeout: 15_000 })
    .toMatchObject({ stage: "answered", closedBy: "user", answer: "Keep for replay" });
  await page.keyboard.press("Escape");

  // Its feature's sheet shows it as the worker wrote it, with the orchestrator's note; Dismiss
  // takes a reason, which the worker is told.
  await openFeatureOf(page, "WQ2");
  const second = page.locator('[data-testid="worker-question"][data-question="WQ2"]');
  await expect(second.getByTestId("question-status")).toHaveText(
    /^Forwarded to you, untriaged · \d\d:\d\d$/,
  );
  await expect(second.getByTestId("question-recommendation")).toHaveText(
    "Recommends: Yes: 3.9 is past end of life and CI no longer runs it.",
  );
  await second.getByTestId("question-dismiss").click();
  // The reason is focused as it opens, and typed into once it has.
  await expect(second.getByTestId("question-dismiss-reason")).toBeFocused();
  await second.getByTestId("question-dismiss-reason").fill("Ask again after the release.");
  await second.getByTestId("question-dismiss-confirm").click();
  await expect(second).toHaveCount(0);
  await expect.poll(() => countOf(page)).toBe(before - 2);
  expect(await stageOf(page, made.workspaceId, "WQ2")).toMatchObject({
    stage: "dismissed",
    reason: "Ask again after the release.",
  });
  await page.keyboard.press("Escape");

  // The worker's own thread: its card moved on in place, and the answer reached it.
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/t/${made.working}`);
  const transcriptCard = page.locator('[data-testid="worker-question-card"][data-question="WQ1"]');
  await expect(transcriptCard).toHaveAttribute("data-stage", "answered");
  await expect(transcriptCard.getByTestId("question-status")).toHaveText(
    /^Answered by you · \d\d:\d\d$/,
  );
  await expect(page.getByText(/^The user answered your question WQ1/)).toBeVisible();
  // The one dismissed earlier keeps its history beside it.
  await expect(
    page.locator('[data-testid="worker-question-card"][data-question="WQ5"]'),
  ).toContainText("Out of scope for this feature.");
});

test("the feature sheet keeps each question's history: who answered and when", async ({ page }) => {
  await start(page);
  // The working worker's feature: its forwarded question, and the one the user dismissed.
  const ledgerFeature = await page.evaluate(async () => {
    const [state] = await window.gramMock!.listWorkspaces();
    const ledger = await window.gramMock!.orchestratorLedger(state!.workspace.id);
    return ledger.questions?.find((question) => question.id === "WQ5")?.feature;
  });
  await page
    .getByTestId("rail-board")
    .locator(`[data-testid="rail-row"][data-feature="${ledgerFeature}"]`)
    .getByTestId("rail-feature")
    .click();
  const questions = page.getByTestId("feature-sheet-questions");
  await expect(questions.getByTestId("worker-question")).toHaveCount(1);
  const forwarded = questions.getByTestId("worker-question");
  await expect(forwarded.getByTestId("question-note")).toHaveText(
    "Orchestrator: I'd keep them: the relay worker reads the same queue, so its brief changes too.",
  );
  await expect(forwarded.getByTestId("question-status")).toHaveText(
    /^Forwarded to you · \d\d:\d\d$/,
  );
  const dismissed = questions.locator(
    '[data-testid="worker-question-history"][data-question="WQ5"]',
  );
  await expect(dismissed).toHaveAttribute("data-stage", "dismissed");
  await expect(dismissed.getByTestId("question-status")).toHaveText(
    /^Dismissed by you · \d\d:\d\d$/,
  );
  // The orchestrator's answer elsewhere names what settled it, on its own feature's sheet.
  await page.keyboard.press("Escape");
  const briefedFeature = await page.evaluate(async () => {
    const [state] = await window.gramMock!.listWorkspaces();
    const ledger = await window.gramMock!.orchestratorLedger(state!.workspace.id);
    return ledger.questions?.find((question) => question.id === "WQ4")?.feature;
  });
  await page
    .getByTestId("rail-board")
    .locator(`[data-testid="rail-row"][data-feature="${briefedFeature}"]`)
    .getByTestId("rail-feature")
    .click();
  const answered = page.locator('[data-testid="worker-question-history"][data-question="WQ4"]');
  await expect(answered).toContainText(
    "A query parameter named `limit`, capped at 100. (settled by decisions.md: list endpoints take `limit`)",
  );
  await expect(answered.getByTestId("question-status")).toHaveText(
    /^Answered by the orchestrator · \d\d:\d\d$/,
  );
});

test("a forwarded question's Answer, on its feature's sheet, opens the Inbox on it", async ({
  page,
}) => {
  const made = await start(page);
  await openFeatureOf(page, "WQ1");
  await page
    .locator('[data-testid="worker-question"][data-question="WQ1"]')
    .getByRole("button", { name: "Answer" })
    .click();
  await expect(inbox(page)).toBeVisible();
  await expect(detail(page)).toHaveAttribute(
    "data-key",
    `ask:worker-question:${made.workspaceId}:WQ1`,
  );
});

for (const mode of ["dark", "light"] as const) {
  test(`the question in the Inbox and the needs-you pill read in ${mode} mode`, async ({
    page,
  }) => {
    await seedTheme(page, {
      mode,
      motion: "off",
      palette: mode === "light" ? "catppuccin-latte" : "catppuccin-mocha",
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    const made = await start(page);
    await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
    await expect(needsYou(page)).toHaveAccessibleName(/need(s)? you: /);
    await openInbox(page);
    await row(page, made.workspaceId, "WQ1").click();
    await expect(
      detail(page).getByTestId("ask-option").filter({ hasText: "Keep for replay" }),
    ).toBeVisible();
    if (SHOTS !== undefined) {
      await inbox(page).screenshot({ path: `${SHOTS}/inbox-${mode}.png` });
      await page.keyboard.press("Escape");
      await needsYou(page).screenshot({ path: `${SHOTS}/needs-you-${mode}.png` });
    }
  });
}

test("on the Board, a worker that asks is a click from its ask in the Inbox", async ({ page }) => {
  const made = await start(page);
  const chip = page
    .getByTestId("rail-worker")
    .and(page.locator(`[data-thread-id="${made.working}"]`));
  await expect(chip).toHaveAttribute("data-asking", "true");
  await chip.getByTestId("rail-worker-open").click();
  // The Inbox opens over the Board, on that worker's question.
  await expect(inbox(page)).toBeVisible();
  await expect(detail(page)).toHaveAttribute(
    "data-key",
    `ask:worker-question:${made.workspaceId}:WQ1`,
  );
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("rail-board")).toBeVisible();
});

test("a long question's own card, a click away in the Inbox, keeps its answer row in sight", async ({
  page,
}) => {
  const made = await start(page);
  await page.setViewportSize({ width: 1280, height: 560 });
  // WQ1 grows long: a fifth choice and a long context.
  await page.evaluate(
    async ([workspace]) => {
      const mock = window.gramMock!;
      const ledger = await mock.orchestratorLedger(workspace as never);
      const question = ledger.questions?.find((each) => each.id === "WQ1");
      if (question === undefined) throw new Error("no WQ1");
      await mock.simulateWorkerQuestion({
        ...question,
        context: `${question.context ?? ""} ${"The relay retries on its own schedule. ".repeat(12)}`,
        options: [
          ...(question.options ?? []),
          { label: "Park it", description: "Hold the job until someone looks." },
          { label: "Ask the sender", description: "Mail the sender a link to retry." },
          { label: "Retry with backoff", description: "Five tries, then report it." },
        ],
      });
    },
    [made.workspaceId] as const,
  );
  await openInbox(page);
  await row(page, made.workspaceId, "WQ1").click();
  await detail(page).getByTestId("inbox-read-full").click();
  const full = detail(page).getByTestId("inbox-ask");
  await expect(full).toHaveAttribute("data-full", "true");
  await expect(full).toContainText("The relay retries on its own schedule.");
  // Every choice is there, and the answer row stays on screen whatever the scroll.
  await expect(full.getByRole("radio")).toHaveCount(6);
  const answerRow = full.getByTestId("ask-sheet-answer-row");
  await expect(answerRow).toBeInViewport();
  await expect(answerRow.getByTestId("question-send")).toBeDisabled();
  await full.getByRole("radio", { name: /^Retry with backoff/ }).click();
  await expect(answerRow).toBeInViewport();
  // The same keys as everywhere: a number picks, ⌘⏎ sends.
  await page.keyboard.press("2");
  await expect(full.getByRole("radio", { name: /^Keep for replay/ })).toBeChecked();
  await page.keyboard.press("5");
  await expect(full.getByRole("radio", { name: /^Retry with backoff/ })).toBeChecked();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(row(page, made.workspaceId, "WQ1")).toHaveCount(0);
  await expect
    .poll(async () => (await stageOf(page, made.workspaceId, "WQ1"))?.stage)
    .toBe("answered");
});
