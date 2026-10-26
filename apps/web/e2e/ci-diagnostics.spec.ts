import { expect, test } from "@playwright/test";

test("PR job diagnostics show exact provenance and annotations before a bounded excerpt", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto("/t/t-flaky");
  await page.getByRole("tab", { name: "PR", exact: true }).click();
  const checks = page.getByTestId("pr-panel").getByRole("region", { name: "Checks" });
  await expect(page.getByTestId("ci-job-detail")).toHaveCount(0);
  await checks.getByRole("button", { name: "Inspect test (windows) job", exact: true }).click();
  const detail = checks.getByTestId("ci-job-detail");
  await expect(detail).toContainText("Run 9102 · Attempt 1 · Job 3");
  await expect(detail).toContainText("Runner synthetic-runner");
  await expect(detail).toContainText("Step: Run tests");
  await expect(detail).toContainText("GitHub annotation");
  await expect(detail).toContainText("Its cause is not established.");
  await expect(detail.locator("time").first()).toHaveText(
    /\d{4}-\d{2}-\d{2} \d{2}:05:00 UTC[+-]\d{2}:\d{2}/,
  );
  await expect(
    detail.getByRole("link", { name: "Inspect test (windows) on GitHub" }),
  ).toHaveAttribute("href", "https://github.com/example/api/actions/runs/9102/job/3");
  await detail.getByRole("button", { name: "Read redacted log excerpt" }).click();
  await expect(detail).toContainText("Log excerpt");
  await expect(detail.getByRole("button", { name: "Read redacted log excerpt" })).toHaveCount(0);
  await detail.scrollIntoViewIfNeeded();
});
