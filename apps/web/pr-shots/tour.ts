import { expect, type Page } from "@playwright/test";

import { openOrchestrator, threadRow } from "../e2e/thread-row";
import { seedMockSettings, SHOTS, type Shot } from "./shots";

// Contributor-only staging. Keep the ordinary before/after catalogue and product UI unchanged.
const existing = (name: string): Shot["open"] => {
  const shot = SHOTS.find((candidate) => candidate.name === name);
  if (!shot) throw new Error(`tour: missing shot ${name}`);
  return shot.open;
};

const openScene = async (page: Page) => {
  await seedMockSettings(page, { panel: { open: false } });
  await page.goto("/t/t-flaky");
  await threadRow(page, "t-flaky").waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  await openOrchestrator(page, made.orchestratorThreadId);
  await page.getByLabel("Message", { exact: true }).waitFor();
  return made;
};

const board = async (page: Page) => {
  await page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  await expect(page.getByTestId("rail-board")).toBeVisible();
};

const openMemory = async (page: Page) => {
  await page.goto("/t/t-flaky");
  await threadRow(page, "t-flaky").waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOrchestration("board"));
  await openOrchestrator(page, made.orchestratorThreadId);
  await page.getByRole("link", { name: "Memory", exact: true }).click();
  await expect(page.getByTestId("memory-file")).toHaveCount(6);
};

const composer = async (page: Page) => {
  await seedMockSettings(page, { panel: { open: false } });
  await page.goto("/t/t-deps");
  await page
    .getByLabel("Message", { exact: true })
    .fill("Add retry coverage for the queue consumer.");
};

const scenes: readonly Shot[] = [
  {
    name: "first-run",
    title: "First run: repository choice and installed tools",
    open: existing("first-run"),
  },
  {
    name: "orchestrator",
    title: "Orchestrator: populated feature cards, asks, and workers in several states",
    open: async (page) => {
      await openScene(page);
      await expect(page.getByTestId("overview-worker").first()).toBeVisible();
    },
  },
  {
    name: "board",
    title: "Board: grouped features and worker stages",
    open: async (page) => {
      await openScene(page);
      await board(page);
    },
  },
  {
    name: "worker-transcript",
    title: "Worker: long retry transcript, tool calls, and an expanded edit diff",
    open: async (page) => {
      const made = await openScene(page);
      await threadRow(page, made.live).click();
      await expect(page.getByTestId("message-assistant").last()).toBeVisible();
      await page.getByTestId("transcript").evaluate((el) => el.scrollTo({ top: 0 }));
      await page.getByRole("button", { name: /^Working for/ }).click();
      const edit = page.getByTestId("file-edit").first();
      await edit.getByRole("button").last().click();
      await edit.scrollIntoViewIfNeeded();
      await expect(edit).toContainText("ack(message)");
    },
  },
  {
    name: "composer-model",
    title: "Composer: drafted message with the model picker open",
    open: async (page) => {
      await composer(page);
      await page.getByRole("combobox", { name: "Model", exact: true }).click();
      await expect(page.getByRole("listbox")).toBeVisible();
    },
  },
  {
    name: "composer-mode",
    title: "Composer: permission mode picker open",
    open: async (page) => {
      await composer(page);
      await page.getByRole("combobox", { name: /^Mode: / }).click();
      await expect(page.getByRole("option", { name: "Bypass", exact: true })).toBeVisible();
    },
  },
  {
    name: "composer-controls",
    title: "Composer: additional controls menu open",
    open: async (page) => {
      await composer(page);
      await page.getByRole("button", { name: "More composer controls" }).click();
      await expect(page.getByTestId("composer-overflow-menu")).toBeVisible();
    },
  },
  {
    name: "needs-you",
    title: "Needs you: requests across workspaces, including failures and reviews",
    open: existing("needs-you"),
  },
  {
    name: "questions",
    title:
      "Questions: a forwarded question's Answer turns the Asks dock to it, the one place it is answered",
    open: async (page) => {
      await page.goto("/t/t-flaky");
      await threadRow(page, "t-flaky").waitFor();
      const made = await page.evaluate(() => window.gramMock!.simulateWorkerQuestions());
      await openOrchestrator(page, made.orchestratorThreadId);
      await board(page);
      await page.getByTestId("rail-waiting-chip").click();
      const question = page.locator('[data-testid="rail-waiting"] [data-question="WQ1"]');
      await question.getByRole("button", { name: "Answer" }).click();
      await expect(question.getByTestId("question-answering")).toBeVisible();
      const item = page
        .getByTestId("rail-board")
        .locator(
          `[data-testid="ask-item"][data-ask-key="worker-question:${made.workspaceId}:WQ1"]`,
        );
      await expect(item.getByTestId("ask-option").first()).toBeVisible();
    },
  },
  {
    name: "history",
    title: "History: every past chat, searchable, with type chips, grouped by date",
    open: async (page) => {
      await openScene(page);
      await page.getByTestId("overview-history").click();
      await expect(page.getByTestId("history-row").first()).toBeVisible();
      await page.mouse.move(1400, 880);
      await page.waitForTimeout(300);
    },
  },
  {
    name: "quiet",
    title: "Quiet: workers running or waiting, with the workspace peek open",
    open: async (page) => {
      await existing("readme-quiet")(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByTestId("quiet-strip-workspace").first().click();
      await expect(page.getByTestId("quiet-peek")).toBeVisible();
    },
  },
  { name: "workers", title: "⌘J: populated workspace worker list", open: existing("workers-list") },
  {
    name: "settings-general",
    title: "Settings: General preferences",
    open: async (page) => {
      await page.goto("/settings/general");
      await expect(page.getByTestId("general-settings")).toBeVisible();
    },
  },
  {
    name: "settings-agents",
    title: "Settings: installed agents and model preferences",
    open: async (page) => {
      await page.goto("/settings/agents");
      await expect(page.getByTestId("agent-settings")).toBeVisible();
      await page.getByRole("combobox", { name: "Model", exact: true }).first().waitFor();
    },
  },
  {
    name: "dreams",
    title: "Dreams: seeded running, completed, and failed memory work",
    open: async (page) => {
      await openMemory(page);
      await expect(page.getByTestId("dream-row")).toHaveCount(3);
      await page.getByTestId("dreams").scrollIntoViewIfNeeded();
    },
  },
  {
    name: "memory",
    title: "Memory: populated file list and goals editor",
    open: async (page) => {
      await openMemory(page);
      await page.locator('[data-testid="memory-file"][data-path="goals.md"]').click();
      await expect(page.getByTestId("memory-text")).toHaveValue(/Ship the mail trigger/);
    },
  },
  {
    name: "approval",
    title: "Approval: scripted tool request waiting for the user",
    open: existing("thread"),
  },
  {
    name: "failure",
    title: "Failure: stopped worker and failing CI on the Board",
    open: existing("board-failing"),
  },
  {
    name: "command-palette",
    title: "⌘K: command palette over a populated thread",
    open: existing("command-palette"),
  },
  {
    name: "new-workspace",
    title: "New workspace: repositories, goal, and autonomy",
    open: existing("new-workspace"),
  },
];

/** Ordered whole-window frames, always both modes and 1440 × 900 regardless of source shot. */
export const TOUR: readonly Shot[] = scenes.map((shot, index) => ({
  name: `${String(index + 1).padStart(2, "0")}-${shot.name}`,
  title: shot.title,
  open: async (page) => {
    await shot.open(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.mouse.move(1438, 898);
  },
}));
