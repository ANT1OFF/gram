import { expect, test, type Page } from "@playwright/test";

import type { ThreadId } from "@gram/contracts";

const WAIT = "t-release-notes" as ThreadId;

/** A thread started before its machine, opened from its sidebar row. */
async function openWaiting(page: Page, awaitingMachine: { failed?: string } = {}) {
  await page.goto("/");
  await page.waitForFunction(() => window.gramMock !== undefined);
  await page.evaluate(
    ([id, wait]) =>
      window.gramMock!.simulateThread({
        id,
        title: "Release notes",
        messages: [
          { role: "user", text: "Draft the release notes for 2.4." },
          { role: "user", text: "Keep it under 300 words." },
        ],
        awaitingMachine: wait,
      }),
    [WAIT, awaitingMachine] as const,
  );
  const row = page.locator(`[data-testid="overview-solo"][data-thread-id="${WAIT}"]`);
  await expect(row).toBeVisible();
  return row;
}

test("a thread whose machine is starting keeps the first message and says so", async ({ page }) => {
  const row = await openWaiting(page);
  await expect(row).toHaveAttribute("aria-label", "Release notes, Machine starting");
  await expect(row).toHaveAttribute("title", /Its machine is starting · 2 messages wait · since /);
  await row.click();

  const view = page.getByTestId("thread-view");
  await expect(page.getByTestId("pane-machine")).toHaveText("machine starting");
  await expect(view.getByTestId("machine-wait-message")).toContainText(
    "Draft the release notes for 2.4.",
  );
  await expect(view.getByTestId("machine-wait-held")).toContainText(
    "sent when the machine has started",
  );
  await expect(view.getByTestId("machine-wait-starting")).toContainText(
    "Starting this thread's machine · usually under a minute",
  );
  await expect(view.getByText("no longer joined")).toHaveCount(0);

  // What is written now waits too, after the one already waiting.
  const composer = view.getByLabel("Message", { exact: true });
  await expect(composer).toHaveAttribute(
    "placeholder",
    "Add a message. It is sent when the machine has started.",
  );
  await composer.fill("And link the pull requests.");
  await composer.press("Enter");
  const queue = view.getByTestId("queue");
  await expect(queue).toContainText("Queued · waits for the machine");
  await expect(queue.getByTestId("queue-item")).toHaveText([
    "Keep it under 300 words.",
    "And link the pull requests.",
  ]);
  await expect(queue.getByTestId("queue-steer")).toHaveCount(0);
});

test("a thread no machine came for says why, and follows the wait once it begins again", async ({
  page,
}) => {
  const row = await openWaiting(page, {
    failed: "The machine couldn't be started: no capacity in this region.",
  });
  await expect(row.getByTestId("overview-solo-status")).toHaveText("No machine");
  await expect(row).toHaveAttribute("title", /No machine started · Try again in the thread/);
  await row.click();

  const view = page.getByTestId("thread-view");
  await expect(page.getByTestId("pane-machine")).toHaveText("no machine");
  await expect(view.getByTestId("machine-wait-sentence")).toHaveText(
    "The machine couldn't be started: no capacity in this region.",
  );
  await expect(view.getByTestId("machine-wait-held")).toContainText("not sent yet, and kept");
  // Gram on its own has nobody to ask for another machine.
  await expect(view.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(view.getByTestId("machine-wait-failed")).toContainText(
    "What you sent is kept. To try again, start the thread again.",
  );

  await page.evaluate((id) => window.gramMock!.simulateMachineWait(id), WAIT);
  await expect(view.getByTestId("machine-wait-starting")).toContainText(
    "Starting a machine again · the first didn't start",
  );
  await expect(page.getByTestId("pane-machine")).toHaveText("machine starting");
  await expect(row).toHaveAttribute("aria-label", "Release notes, Machine starting");
});
