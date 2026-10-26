import { expect, test } from "@playwright/test";

import { openOverviewDensity } from "./overview-density";
import { seedTheme } from "./seed-theme";

// The overview header's New task is the one way in to a new task's draft: the orchestrator plans
// it or it goes straight to a worker. Its place in the header at each width is in
// sidebar-top-utilities.spec.ts.

test("New task explains itself on hover and Tab and opens a reviewable draft", async ({
  page,
  context,
}) => {
  await seedTheme(page, { palette: "minimal-ocean", mode: "dark", motion: "off" });
  await openOverviewDensity(page, 180);
  const before = await page.evaluate(async () => ({
    threads: window.gramMock!.world.threads().length,
    workspaces: (await window.gramMock!.listWorkspaces()).length,
  }));
  const sidebar = page.getByTestId("overview-sidebar");
  const task = sidebar.getByRole("button", { name: "New task", exact: true });
  await expect(task).toHaveAttribute("title", /^New task \(.+\)$/);
  await sidebar.getByRole("button", { name: "Compact overview", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(task).toBeFocused();
  expect(await task.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/new-task$/);
  const draft = page.getByRole("form", { name: "New task" });
  await draft.getByRole("radio", { name: "Straight to a worker" }).click();
  await expect(draft.getByRole("radio", { name: "Straight to a worker" })).toBeChecked();
  await expect(draft.getByRole("button", { name: "Start worker", exact: false })).toBeDisabled();
  await draft.getByLabel("What needs doing").fill("Synthetic draft kept for review");
  await draft.getByLabel("What needs doing").evaluate((element) => {
    const files = new DataTransfer();
    files.items.add(
      new File(["Invented attachment content"], "synthetic-brief.txt", { type: "text/plain" }),
    );
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: files }));
  });
  await expect(draft.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready");
  const targetBefore = await draft.getByTestId("task-target").textContent();

  // New task again, by its button or ⌘N, keeps the draft as it was.
  await task.click();
  await expect(page).toHaveURL(/\/new-task$/);
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page).toHaveURL(/\/new-task$/);
  await expect(draft.getByLabel("What needs doing")).toHaveValue("Synthetic draft kept for review");
  await expect(draft.getByTestId("task-target")).toHaveText(targetBefore!);
  await expect(draft.getByTestId("attachment-chip")).toContainText("synthetic-brief.txt");

  // A middle-click opens the draft page in a window of its own.
  const popupPromise = context.waitForEvent("page");
  await task.click({ button: "middle" });
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await expect(popup).toHaveURL(/\/new-task$/);
  await expect(popup.getByRole("form", { name: "New task" })).toBeVisible();
  await popup.close();
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
    .getByRole("button", { name: "New task", exact: true })
    .click();
  const draft = page.getByRole("form", { name: "New task" });
  await draft.getByRole("radio", { name: "Straight to a worker" }).click();
  await expect(draft.getByRole("radio", { name: "Straight to a worker" })).toBeChecked();
  await draft.getByLabel("What needs doing").fill("Synthetic refusal fixture");
  await expect(
    draft.getByText("Synthetic provider is signed out; log in explicitly.").first(),
  ).toBeVisible();
  await expect(draft.getByRole("button", { name: /Start.*worker/ })).toBeDisabled();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page).toHaveURL(/\/new-task$/);
  expect(await page.evaluate(() => window.gramMock!.world.threads().length)).toBe(before);
});
