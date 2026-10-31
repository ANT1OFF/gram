import { expect, test, type Page } from "@playwright/test";

import { threadRow } from "./thread-row";

/** Opens t-flaky and approves its push, so the scripted turn runs to its end. */
async function finishFlaky(page: Page) {
  await page.goto("/t/t-flaky");
  const approval = page.getByTestId("approval-card");
  await expect(approval).toContainText("git push origin fix/flaky-retry", { timeout: 20_000 });
  await approval.getByTestId("approval-allow").click();
  const row = page.getByTestId("turn-fold");
  await expect(row).toHaveAttribute("data-state", "worked", { timeout: 30_000 });
  return row;
}

test("a finished turn folds to one row and keeps its last words and offer", async ({ page }) => {
  const row = await finishFlaky(page);
  const transcript = page.getByTestId("transcript");

  await expect(row).toHaveText(/^Worked for \d+s · 5 tools$/);
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(transcript.getByText("Done. Summary:")).toBeVisible();
  await expect(transcript.getByText("Fix the same sleep in poll.test.ts")).toBeVisible();
  await expect(transcript.getByTestId("chapter")).toHaveCount(0);
  await expect(transcript.getByTestId("tool-group")).toHaveCount(0);
  await expect(transcript.getByTestId("tool-card")).toHaveCount(0);
  await expect(transcript.getByText("I'll start by reading the test")).toBeHidden();

  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(transcript.getByTestId("chapter")).toHaveCount(3);
  await expect(transcript.getByText("I'll start by reading the test")).toBeVisible();
});

test("a thread remembers the turn you opened", async ({ page }) => {
  const row = await finishFlaky(page);
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");

  await threadRow(page, "t-deps").click();
  await expect(page).toHaveURL(/\/t\/t-deps$/);
  await threadRow(page, "t-flaky").click();
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
  await expect(page.getByTestId("turn-fold")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("transcript").getByTestId("chapter")).toHaveCount(3);

  await page.reload();
  // A restart forgets it; the scripted thread starts over, so this is its running row, closed.
  await expect(page.getByTestId("turn-fold")).toHaveAttribute("aria-expanded", "false", {
    timeout: 20_000,
  });
});

test("while a turn runs only its finished steps fold", async ({ page }) => {
  await page.goto("/t/t-flaky");
  await expect(page.getByTestId("approval-card")).toBeVisible({ timeout: 20_000 });
  const transcript = page.getByTestId("transcript");
  const row = page.getByTestId("turn-fold");

  await expect(row).toHaveAttribute("data-state", "running");
  await expect(row).toHaveText(/^Working for \d+s · 4 tools$/);
  await expect(transcript.getByText("The test passes 20/20 now.")).toBeVisible();
  await expect(transcript.getByText("Bash", { exact: true })).toBeVisible();
  await expect(transcript.getByText("Confirmed: 3 of 20 runs fail.")).toBeHidden();
});

test("a stopped turn says so", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const approval = page.getByTestId("approval-card");
  await expect(approval).toBeVisible({ timeout: 20_000 });
  // The mock takes a stop at the turn's next step, which here is the answer.
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await approval.getByTestId("approval-allow").click();
  const row = page.getByTestId("turn-fold");
  await expect(row).toHaveAttribute("data-state", "stopped");
  await expect(row).toHaveText(/^Stopped after \d+s · 4 tools$/);
});

test("a failed turn keeps its failed tool and error card in view", async ({ page }) => {
  await page.goto("/t/t-deps");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const at = Date.now();
    const mock = window.gramMock!;
    mock.simulateMessage("t-deps" as never, {
      id: "failed-prompt",
      role: "user",
      metadata: { createdAt: at - 161_000 },
      parts: [{ type: "text", text: "Push the branch" }],
    });
    mock.simulateMessage(
      "t-deps" as never,
      {
        id: "failed-reply",
        role: "assistant",
        metadata: { turnEnd: { at, reason: "error" } },
        parts: [
          { type: "text", text: "Reading the remote config.", state: "done" },
          {
            type: "tool-Read",
            toolCallId: "read",
            state: "output-available",
            input: { file_path: "/repo/.git/config" },
            output: "",
          },
          { type: "text", text: "Pushing now.", state: "done" },
          {
            type: "tool-Bash",
            toolCallId: "push",
            state: "output-error",
            input: { command: "git push" },
            errorText: "remote rejected",
          },
          {
            type: "data-agent-error",
            id: "error-failed",
            data: { kind: "network", text: "The connection dropped.", retryable: false, at },
          },
        ],
      } as never,
    );
  });
  const reply = page.locator('[data-message-id="failed-reply"]');
  const row = reply.getByTestId("turn-fold");
  await expect(row).toHaveText("Failed after 2m 41s · 2 tools· 1 failed");
  await expect(reply.getByText("Pushing now.")).toBeVisible();
  await expect(reply.locator('[data-tool-call-id="push"]')).toBeVisible();
  await expect(reply.getByTestId("agent-error")).toContainText("The connection dropped.");
  await expect(reply.getByText("Reading the remote config.")).toBeHidden();
  await expect(reply.locator('[data-tool-call-id="read"]')).toHaveCount(0);
});

test("Find opens the fold around a hit", async ({ page }) => {
  const row = await finishFlaky(page);
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByLabel("Find in thread").fill("Confirmed: 3 of 20");
  await expect(page.getByTestId("find-status")).toHaveText("1 of 1");
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByTestId("transcript").getByText("Confirmed: 3 of 20 runs fail."),
  ).toBeInViewport();
});

test("a chapter jump opens the fold it lands in", async ({ page }) => {
  const row = await finishFlaky(page);
  await page.getByRole("button", { name: "Contents", exact: true }).click();
  await page.getByTestId("toc").getByRole("menuitem", { name: "Fix", exact: true }).click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("transcript").getByTestId("chapter")).toHaveCount(3);
});
