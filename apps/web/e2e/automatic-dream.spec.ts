import { expect, test } from "@playwright/test";

test("automatic Dream is opt-in, validates its threshold, and saves its workspace charter across route remounts", async ({
  page,
}) => {
  await page.goto("/settings/workspaces");
  const open = async () => {
    await page
      .getByRole("listitem", { name: "Workspace Automatic Dream fixture" })
      .getByTestId("workspace-link")
      .click();
    await page.getByTestId("workspace-advanced").click();
  };
  await page.waitForFunction(() => window.gramMock !== undefined);
  await page.evaluate(async () => {
    const api = window.gramMock!;
    const project = (await api.listProjects())[0]!;
    await api.saveWorkspace({
      name: "Automatic Dream fixture",
      projectIds: [project.id],
      homeProjectId: project.id,
    });
    // A charter save that takes a moment, as a real server's does: the switch shows a choice at
    // once rather than when the save and the refetch finish.
    const save = api.setOrchestratorCharter.bind(api);
    api.setOrchestratorCharter = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return save(...args);
    };
  });
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "General", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Workspaces", exact: true })
    .click();
  await open();
  // Dream sits under Advanced on the workspace's own settings page.
  const section = page.getByTestId("workspace-page");
  const toggle = section.getByRole("switch", { name: "Dream automatically" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  const threshold = section.getByRole("spinbutton", { name: "Completed threads before Dream" });
  await expect(threshold).toHaveValue("10");
  await expect(section.getByTestId("automatic-dream-progress")).toContainText(
    "0 / 10 completed threads",
  );
  await expect(section.getByTestId("automatic-dream-setting")).toContainText(
    "changing the threshold starts a fresh count",
  );
  await threshold.fill("1001");
  await threshold.press("Enter");
  await expect(section.getByRole("alert")).toContainText("1 to 1000");
  await threshold.fill("25");
  await threshold.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.gramMock!.listWorkspaces())[0]!.charter.automaticDreamThreshold,
      ),
    )
    .toBe(25);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "General", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Workspaces", exact: true })
    .click();
  await open();
  await expect(threshold).toHaveValue("25");
  await expect(section.getByTestId("automatic-dream-progress")).toContainText(
    "Automatic runs await review",
  );
  await section.getByTestId("automatic-dream-setting").screenshot({
    path: test.info().outputPath("automatic-dream-settings.png"),
  });
  await toggle.uncheck();
  await expect(threshold).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "General", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Workspaces", exact: true })
    .click();
  await open();
  await expect(toggle).not.toBeChecked();
});
