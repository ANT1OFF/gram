import { expect, test } from "@playwright/test";

import { openOverviewDensity } from "./overview-density";
import { seedTheme } from "./seed-theme";

// The overview header's `+` opens the New menu: a task for a workspace's orchestrator, a worker in
// one, a one-off thread, or a new workspace, each landing on its own first screen. Its place in the
// header at each width is in sidebar-top-utilities.spec.ts.

test("New explains itself, works from the keyboard, lands each pick and opens on the last one", async ({
  page,
}) => {
  await seedTheme(page, { palette: "minimal-ocean", mode: "dark", motion: "off" });
  const board = await openOverviewDensity(page, 180);
  const before = await page.evaluate(async () => ({
    threads: window.gramMock!.world.threads().length,
    workspaces: (await window.gramMock!.listWorkspaces()).length,
  }));
  const sidebar = page.getByTestId("overview-sidebar");
  const add = sidebar.getByRole("button", { name: "New", exact: true });
  await expect(add).toHaveAttribute("title", "New task, worker, one-off thread or workspace");
  await expect(add).toHaveAttribute("aria-haspopup", "menu");
  await sidebar.getByRole("button", { name: "Compact overview", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(add).toBeFocused();
  expect(await add.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");

  // Enter opens it on the task row; each row says where it goes and its shortcut.
  await page.keyboard.press("Enter");
  const menu = page.getByTestId("new-entry-menu");
  await expect(menu).toBeVisible();
  const task = page.getByTestId("new-entry-task");
  await expect(task).toHaveAttribute("data-highlighted", "");
  await expect(task).toContainText(/Task for .+'s orchestrator|New task/);
  await expect(page.getByTestId("new-entry-worker")).toContainText(/Worker in .+|New worker/);
  await expect(page.getByTestId("new-entry-oneOff")).toContainText("One-off thread");
  await expect(page.getByTestId("new-entry-workspace")).toContainText("New workspace…");
  await expect(menu.getByRole("separator")).toHaveCount(1);

  // → opens Send to on the worker row, ← comes back, and a workspace there is the target.
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("new-entry-worker")).toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("ArrowRight");
  const sendTo = page.getByTestId("new-entry-worker-to");
  await expect(sendTo).toBeVisible();
  await expect(sendTo).toContainText("Send to");
  await page.keyboard.press("ArrowLeft");
  await expect(sendTo).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(sendTo.getByRole("menuitem", { name: "agent-platform" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`/new-task\\?way=direct&workspace=${board.workspaceId}$`),
  );
  const draft = page.getByRole("form", { name: "New task" });
  await expect(draft.getByRole("heading", { name: "New worker" })).toBeVisible();
  await expect(draft.getByTestId("task-target")).toHaveText("Worker in agent-platform");
  await expect(draft.getByRole("radiogroup")).toHaveCount(0);
  await draft.getByLabel("What needs doing").fill("Synthetic draft kept for review");

  // Opened again, the menu starts on the worker row, so Enter repeats it and keeps the draft.
  await add.click();
  await expect(page.getByTestId("new-entry-worker")).toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(draft.getByRole("heading", { name: "New worker" })).toBeVisible();
  await expect(draft.getByLabel("What needs doing")).toHaveValue("Synthetic draft kept for review");

  // ⌘N is still the task, ⌥⌘N the worker.
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page).toHaveURL(/\/new-task$/);
  await expect(draft.getByRole("heading", { name: "New task" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await expect(page).toHaveURL(/\/new-task\?way=direct$/);
  await expect(draft.getByRole("heading", { name: "New worker" })).toBeVisible();

  // The other two rows land on their own first screens.
  await add.click();
  await page.getByTestId("new-entry-oneOff").click();
  await expect(page).toHaveURL(/\/new$/);
  await add.click();
  await expect(page.getByTestId("new-entry-oneOff")).toHaveAttribute("data-highlighted", "");
  await page.getByTestId("new-entry-workspace").click();
  await expect(page).toHaveURL(/\/new-workspace$/);
  await add.click();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(add).toBeFocused();

  const after = await page.evaluate(async () => ({
    threads: window.gramMock!.world.threads().length,
    workspaces: (await window.gramMock!.listWorkspaces()).length,
  }));
  expect(after).toEqual(before);
});

test("worker draft keeps the selected unavailable provider blocked without creating anything", async ({
  page,
}) => {
  await seedTheme(page, { palette: "minimal-ocean", mode: "dark", motion: "off" });
  await openOverviewDensity(page, 180);
  await page.evaluate(() => {
    const mock = window.gramMock!;
    mock.agentSupport = async (model) => ({
      model,
      checkedAt: 1,
      availability: {
        state: "signedOut",
        reason: "Synthetic provider is signed out; log in explicitly.",
      },
      support: {
        orchestrator: { state: "supported", evidence: "Explicit synthetic orchestrator policy" },
        worker: { state: "supported", evidence: "Explicit synthetic worker policy" },
      },
    });
  });
  const before = await page.evaluate(() => window.gramMock!.world.threads().length);
  await page
    .getByTestId("overview-sidebar")
    .getByRole("button", { name: "New", exact: true })
    .click();
  await page.getByTestId("new-entry-worker").click();
  const draft = page.getByRole("form", { name: "New task" });
  await expect(draft.getByRole("heading", { name: "New worker" })).toBeVisible();
  await draft.getByLabel("What needs doing").fill("Synthetic refusal fixture");
  await expect(
    draft.getByText("Synthetic provider is signed out; log in explicitly.").first(),
  ).toBeVisible();
  await expect(draft.getByRole("button", { name: /Start.*worker/ })).toBeDisabled();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page).toHaveURL(/\/new-task\?way=direct/);
  expect(await page.evaluate(() => window.gramMock!.world.threads().length)).toBe(before);
});
