import { expect, test, type Page } from "@playwright/test";

// New task starts where you are: the thread you were in (its workspace, or its repo's), or the
// workspace whose page you were on. The last destination used only comes in from neither. While
// the form is open, the title bar names the workspace it goes to, not the one shown before.

/** The realistic scenario's four workspaces, by name. */
async function realistic(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem("gram.mock.orchestration", "realistic"));
  await page.setViewportSize({ width: 1728, height: 1000 });
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  return page.evaluate(async () => {
    const started = await window.gramMock!.startedRealistic();
    if (started === undefined)
      throw new Error("the mock did not start with the realistic scenario");
    const ids = Object.fromEntries(
      (await window.gramMock!.listWorkspaces()).map((s) => [s.workspace.name, s.workspace.id]),
    );
    return { ...started, ids };
  });
}

/** Opens New task with ⌥⌘N: where it goes, and which workspace the title bar names. */
async function newTask(page: Page) {
  await page.keyboard.press("ControlOrMeta+Alt+n");
  await expect(page.getByLabel("What needs doing")).toBeVisible();
  return {
    target: page.getByTestId("task-target"),
    titlebar: page.getByTestId("workspace-switcher-button"),
  };
}

test("from a solo thread, New task goes to its repo's workspace, and the title bar says so", async ({
  page,
}) => {
  await realistic(page);
  // "Bump dependencies" is a solo thread in api, which only billing-api works in. The window last
  // showed Gram's orchestrator, which the title bar named here before.
  await page.goto("/t/t-deps");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  const { target, titlebar } = await newTask(page);
  await expect(target).toHaveText("billing-api");
  await expect(page.getByTestId("task-repo")).toHaveText("api");
  await expect(titlebar).toHaveText("billing-api");
});

test("from a workspace's page, New task goes to that workspace, not the thread left open", async ({
  page,
}) => {
  const made = await realistic(page);
  // A Gram worker in the pane: New task from it goes to Gram.
  await page
    .locator(`[data-testid="overview-worker"][data-thread-id="${made.searchWorker}"]`)
    .click();
  await page.waitForURL(new RegExp(`/t/${made.searchWorker}$`));
  let { target } = await newTask(page);
  await expect(target).toHaveText("Gram");
  await page.goBack();
  await page.waitForURL(new RegExp(`/t/${made.searchWorker}$`));

  // billing-api's own page in Settings, with that worker still in the pane.
  await page.keyboard.press("ControlOrMeta+Comma");
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Workspaces" })
    .click();
  await page.getByTestId("workspace-settings").getByText("billing-api", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/settings/workspaces/${made.ids["billing-api"]}$`));
  ({ target } = await newTask(page));
  await expect(target).toHaveText("billing-api");
});
