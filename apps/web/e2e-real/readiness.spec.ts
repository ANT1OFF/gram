import { expect, test } from "@playwright/test";

import { startHarness } from "./harness";

test("synthetic CLI readiness permits an echo turn without an installed account", async ({
  page,
}) => {
  const h = await startHarness();
  try {
    await h.open(page, "/new");
    await page.getByRole("combobox", { name: "Project path" }).fill(h.repo);
    await expect(page.getByTestId("folder-status")).toBeVisible();
    await page.getByRole("combobox", { name: "First prompt" }).fill("Readiness fixture marker");
    const create = page.getByRole("button", { name: "Create thread" });
    await expect(create).toBeEnabled();
    await create.click();
    await expect(page).toHaveURL(/\/t\/[^/]+$/);
    await expect(page.getByText("echo: Readiness fixture marker")).toBeVisible();
  } finally {
    await h.stop();
  }
});

for (const agent of ["Claude Code", "Codex"]) {
  test(`${agent} synthetic sign-out still refuses a new thread`, async ({ page }) => {
    const h = await startHarness({ agentAuth: "signed-out" });
    try {
      await h.open(page, "/new");
      await page.getByRole("combobox", { name: "Project path" }).fill(h.repo);
      await expect(page.getByTestId("folder-status")).toBeVisible();
      if (agent === "Codex") {
        await page.getByRole("combobox", { name: "Agent", exact: true }).click();
        await page.getByRole("option", { name: "Codex", exact: true }).click();
      }
      await page.getByRole("combobox", { name: "First prompt" }).fill("Must not start");
      await expect(
        page.getByText(
          agent === "Codex"
            ? "Sign in with codex login, then retry."
            : "Sign in with claude auth login, then retry.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Create thread" })).toBeDisabled();
      await expect(page).toHaveURL(/\/new$/);
    } finally {
      await h.stop();
    }
  });
}
