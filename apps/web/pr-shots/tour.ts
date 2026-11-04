import { expect, type Page } from "@playwright/test";

import { openOrchestrator, threadRow } from "../e2e/thread-row";
import { seedMockSettings, SHOTS, type Shot } from "./shots";

// Contributor-only staging. Keep the ordinary before/after catalogue and product UI unchanged.
// The tour shows Gram as a real window does: the realistic scenario (`mock-realistic.ts`), an
// ordinary morning with four orchestrators, five live workers and one ask, at the size of a real
// window. The fixture scenes that pile every state on at once stay, as `stress-` frames at the end,
// so a rater can tell a stress test from the normal view.

/** The window the tour and flows capture: `--size`, else a real 1728 × 1095 window at 2×. */
export const SET_SIZE = (() => {
  const [width, height] = (process.env["GRAM_PR_SHOTS_SIZE"] || "1728x1095").split("x").map(Number);
  if (!width || !height) throw new Error("GRAM_PR_SHOTS_SIZE is <width>x<height>");
  return { width, height };
})();

/**
 * From the next load on, the mock starts with the realistic scenario, and the sidebar is folded as
 * a working window's is: Solo threads folded, and History (Done) grouped by workspace.
 */
export const stageRealistic = (page: Page) =>
  page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.orchestration", "realistic");
    if (localStorage.getItem("gram.layout") === null) {
      localStorage.setItem(
        "gram.layout",
        JSON.stringify({
          version: 1,
          state: {
            overviewFolded: ["solo"],
            doneGrouping: "orchestrator",
          },
        }),
      );
    }
  });

/** What the realistic scenario made, read once the mock has started with it. */
export const realisticMade = (page: Page) =>
  page.evaluate(async () => {
    const made = await window.gramMock!.startedRealistic();
    if (made === undefined) throw new Error("the mock did not start with the realistic scenario");
    return made;
  });

/** The realistic scenario loaded on `path`, the right panel closed; what it made. */
export const openRealistic = async (page: Page, path = "/") => {
  await stageRealistic(page);
  await seedMockSettings(page, { panel: { open: false } });
  await page.goto(path);
  await page.getByTestId("app-shell").waitFor();
  const made = await realisticMade(page);
  await page
    .locator(`[data-testid="overview-workspace"][data-workspace-id="${made.workspaceId}"]`)
    .waitFor();
  return made;
};

/** The realistic "Gram" orchestrator's chat, at the end of its transcript. */
export const openRealisticOrchestrator = async (page: Page) => {
  const made = await openRealistic(page);
  await openOrchestrator(page, made.orchestratorThreadId);
  await page.getByLabel("Message", { exact: true }).waitFor();
  await expect(page.getByTestId("since-you-left")).toBeVisible();
  await page.waitForTimeout(600);
  return made;
};

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

const composer = async (page: Page) => {
  await seedMockSettings(page, { panel: { open: false } });
  await page.goto("/t/t-deps");
  await page
    .getByLabel("Message", { exact: true })
    .fill("Add retry coverage for the queue consumer.");
};

/** A realistic frame: the realistic scenario is in place before `open` loads anything. */
const realistic = (shot: Shot): Shot => ({
  ...shot,
  open: async (page) => {
    await stageRealistic(page);
    await shot.open(page);
  },
});

const workersList = async (page: Page) => {
  await page.getByTestId("overview-hide").click();
  await expect(page.getByTestId("overview-sidebar")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await page.getByTestId("workers-list").waitFor();
  await page.getByTestId("worker-row").first().waitFor();
};

/** The worker "Search in Settings", its first turn's edits and files card in view. */
const openSearchWorker = async (page: Page) => {
  const made = await openRealisticOrchestrator(page);
  await threadRow(page, made.searchWorker).click();
  await page.waitForURL(new RegExp(`/t/${made.searchWorker}$`));
  const card = page.getByTestId("turn-files-card");
  await expect(card).toContainText("3 files changed");
  return made;
};

const scenes: readonly Shot[] = [
  {
    name: "first-run",
    title: "First run: repository choice and installed tools",
    open: existing("first-run"),
  },
  {
    name: "orchestrator",
    title:
      "Orchestrator: a working morning's chat, with replies, merged PRs, digests and Since you left",
    open: async (page) => {
      await openRealisticOrchestrator(page);
    },
  },
  {
    name: "board",
    title: "Board: the workspace's features and where each worker stands",
    open: async (page) => {
      await openRealisticOrchestrator(page);
      await board(page);
    },
  },
  {
    name: "worker-transcript",
    title: "Worker: a finished turn with folded commands, its edits and the files it changed",
    open: async (page) => {
      await openSearchWorker(page);
      // The finished turn opened, as a reader does: its reply, the folded commands and its edits.
      await page.getByTestId("turn-fold").first().click();
      await page.getByRole("button", { name: /^Edited settings-search\.ts/ }).click();
      const edit = page.getByTestId("file-edit").first();
      await edit.getByRole("button").last().click();
      await expect(edit).toContainText("words.every");
      await page.getByTestId("turn-files-card").scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
    },
  },
  realistic({
    name: "composer-model",
    title: "Composer: drafted message with the model picker open",
    open: async (page) => {
      await composer(page);
      await page.getByRole("combobox", { name: "Model", exact: true }).click();
      await expect(page.getByRole("listbox")).toBeVisible();
    },
  }),
  realistic({
    name: "composer-mode",
    title: "Composer: permission mode picker open",
    open: async (page) => {
      await composer(page);
      await page.getByRole("combobox", { name: /^Mode: / }).click();
      await expect(page.getByRole("option", { name: "Bypass", exact: true })).toBeVisible();
    },
  }),
  realistic({
    name: "composer-controls",
    title: "Composer: additional controls menu open",
    open: async (page) => {
      await composer(page);
      await page.getByRole("button", { name: "More composer controls" }).click();
      await expect(page.getByTestId("composer-overflow-menu")).toBeVisible();
    },
  }),
  {
    name: "needs-you",
    title: "Needs you: the one worker question waiting, from the sidebar's pill",
    open: async (page) => {
      await openRealisticOrchestrator(page);
      await page.getByTestId("overview-needs-you").click();
      await page.getByTestId("needs-you-popover").getByTestId("needs-you-item").first().waitFor();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "questions",
    title:
      "Questions: a worker's question in its orchestrator's Asks dock, with the orchestrator's view",
    open: async (page) => {
      const made = await openRealistic(page);
      const orchestrator = await page.evaluate(
        async (id) =>
          (await window.gramMock!.listWorkspaces()).find((w) => w.workspace.id === id)!.workspace
            .orchestratorThreadId!,
        made.askingWorkspaceId,
      );
      await openOrchestrator(page, orchestrator);
      await page.getByTestId("ask-item").first().waitFor();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "history",
    title: "History: every past chat, searchable, with type chips, grouped by workspace",
    open: async (page) => {
      await openRealisticOrchestrator(page);
      await page.getByTestId("overview-history").click();
      await expect(page.getByTestId("history-row").first()).toBeVisible();
      await page.mouse.move(1400, 880);
      await page.waitForTimeout(300);
    },
  },
  {
    name: "quiet",
    title: "Quiet: the workspaces at rest, workers running or waiting, with nothing to answer here",
    open: async (page) => {
      await openRealisticOrchestrator(page);
      await page.getByTestId("titlebar-overflow").click();
      await page.getByTestId("folded-quiet").click();
      await page.getByTestId("quiet-strip-workspace").first().waitFor();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "workers",
    title: "⌘J: the workspace's workers, live and done",
    open: async (page) => {
      await openRealisticOrchestrator(page);
      await workersList(page);
    },
  },
  {
    name: "settings-general",
    title: "Settings: General preferences",
    open: async (page) => {
      await stageRealistic(page);
      await page.goto("/settings/general");
      await expect(page.getByTestId("general-settings")).toBeVisible();
    },
  },
  {
    name: "settings-agents",
    title: "Settings: installed agents and model preferences",
    open: async (page) => {
      await stageRealistic(page);
      await page.goto("/settings/agents");
      await expect(page.getByTestId("agent-settings")).toBeVisible();
      await page.getByRole("combobox", { name: "Model", exact: true }).first().waitFor();
    },
  },
  {
    name: "dreams",
    title:
      "Memory → Update memory: the Dreams action, its mode, and seeded running, completed and failed runs",
    open: async (page) => {
      await openRealisticOrchestrator(page);
      await page.getByRole("link", { name: "Memory", exact: true }).click();
      await expect(page.getByTestId("memory-file")).toHaveCount(6);
      await page.getByTestId("memory-tab-update").click();
      await expect(page.getByTestId("dream-row")).toHaveCount(3);
    },
  },
  {
    name: "memory",
    title: "Memory: populated file list and goals editor",
    open: async (page) => {
      await openRealisticOrchestrator(page);
      await page.getByRole("link", { name: "Memory", exact: true }).click();
      await expect(page.getByTestId("memory-file")).toHaveCount(6);
      await page.locator('[data-testid="memory-file"][data-path="goals.md"]').click();
      await expect(page.getByTestId("memory-text")).toHaveValue(/# Goals/);
    },
  },
  realistic({
    name: "approval",
    title: "Approval: a solo thread's tool request waiting for the user",
    open: existing("thread"),
  }),
  {
    name: "review",
    title: "Review: a worker's turn opened in the Diff panel beside its transcript",
    open: async (page) => {
      await openSearchWorker(page);
      await page.getByTestId("turn-files-chip").click();
      await expect(page.getByTestId("right-panel")).toContainText("settings-search.ts");
      await page.waitForTimeout(600);
    },
  },
  {
    name: "command-palette",
    title: "⌘K: command palette over the orchestrator's chat",
    open: async (page) => {
      await openRealisticOrchestrator(page);
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByTestId("command-palette").getByRole("option").first().waitFor();
      await page.waitForTimeout(300);
    },
  },
  realistic({
    name: "new-workspace",
    title: "New workspace: repositories, goal, and autonomy",
    open: existing("new-workspace"),
  }),
  // Stress tests: every state at once, over the fixture workspaces. Not what a working day looks like.
  {
    name: "stress-many-asks",
    title:
      "Stress test: one orchestrator with a wall of asks, feature cards and workers in every state",
    open: async (page) => {
      await openScene(page);
      await expect(page.getByTestId("overview-worker").first()).toBeVisible();
    },
  },
  {
    name: "stress-board",
    title: "Stress test: the Board with grouped features and every worker stage",
    open: async (page) => {
      await openScene(page);
      await board(page);
    },
  },
  {
    name: "stress-needs-you",
    title: "Stress test: Needs you with requests across workspaces, failures and reviews",
    open: existing("needs-you"),
  },
  {
    name: "stress-failures",
    title: "Stress test: a stopped worker and failing CI on the Board",
    open: existing("board-failing"),
  },
  {
    name: "stress-questions",
    title: "Stress test: a forwarded question's Answer turns the Asks dock to it, among many asks",
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
];

/** Ordered whole-window frames, always both modes and `SET_SIZE` regardless of source shot. */
export const TOUR: readonly Shot[] = scenes.map((shot, index) => ({
  name: `${String(index + 1).padStart(2, "0")}-${shot.name}`,
  title: shot.title,
  open: async (page) => {
    await shot.open(page);
    await page.setViewportSize(SET_SIZE);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.mouse.move(SET_SIZE.width - 2, SET_SIZE.height - 2);
  },
}));
