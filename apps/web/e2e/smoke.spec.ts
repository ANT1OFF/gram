import { expect, test } from "@playwright/test";
import { threadRow } from "./thread-row";

test("streams a scripted thread, approves a request and sends a queued message", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");

  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText("I'll start by reading the test")).toBeVisible();

  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("also update the changelog");
  await composer.press("ControlOrMeta+Enter");
  const queue = page.getByTestId("queue");
  await expect(queue.getByTestId("queue-item")).toContainText("also update the changelog");

  const approval = page.getByTestId("approval-card");
  await expect(approval).toContainText("git push origin fix/flaky-retry", { timeout: 20_000 });
  await approval.getByTestId("approval-allow").click();
  await expect(approval).toBeHidden();

  await expect(
    page.getByTestId("message-user").filter({ hasText: "also update the changelog" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(queue).toBeHidden();
});

test("the overview lists solo threads with their status in words, the parked ones folded", async ({
  page,
}) => {
  await page.goto("/");
  await expect(threadRow(page, "t-question")).toHaveAccessibleName(/, Needs input$/);
  // The overview has no Pinned group of its own: a pinned thread is a solo row like any other.
  await expect(threadRow(page, "t-release")).toContainText("Release checklist");
  // Parked starts folded.
  const parked = page.getByTestId("overview-parked");
  await expect(threadRow(page, "t-grpc")).toBeHidden();
  await parked.getByRole("button", { name: /Parked/ }).click();
  await expect(threadRow(page, "t-grpc")).toBeVisible();
  await expect(parked).toContainText("Spike: gRPC transport");
});
