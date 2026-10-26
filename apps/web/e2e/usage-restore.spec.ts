import { expect, test } from "@playwright/test";

test("an idle thread's usage ring shows its last turn's usage, and stays after a reload", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const ring = page.getByTestId("usage-ring");
  await expect(ring).toHaveAccessibleName(/% of the context window$/);
  await ring.click();
  const usage = page.getByTestId("usage");
  await expect(usage.getByRole("meter", { name: "Context used" })).toBeVisible();
  await expect(usage).toContainText(/\d+% · [\d.]+K \/ 200K tokens/);

  await page.reload();
  await expect(page.getByTestId("usage-ring")).toHaveAccessibleName(/% of the context window$/);
});
