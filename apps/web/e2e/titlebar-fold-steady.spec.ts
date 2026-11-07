import { expect, test, type Page } from "@playwright/test";

// A worker's title bar holds its fold while nothing changes. Folded, the bar is laid out apart: the
// workspace's switcher narrows, so the room the title has then is more than unfolding would leave
// it. Measured folded alone, Take over came back, cut the title short, folded again and so on,
// about 20 times a second at every width between about 980 and 1420 px with these long names.
// Mock state lives in memory, so every step after the seed stays in the app.

const MOCK_SETTINGS_KEY = "gram.mock.settings";

const start = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 720 });
  await page.addInitScript(
    ([key]) => {
      if (sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(
          key,
          JSON.stringify({
            appearance: { mode: "system" },
            panel: { open: false },
            // Take over's ⓘ beside it, as once its first-time line has been read.
            onboarding: { takeOverHintSeen: true },
          }),
        );
      }
    },
    [MOCK_SETTINGS_KEY] as const,
  );
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
  return page.evaluate(async () => {
    const mock = window.gramMock!;
    const made = await mock.simulateOrchestration("board");
    const [state] = await mock.listWorkspaces();
    const { workspace } = state!;
    // Long names, the switcher's, the feature's and the worker's, each cut in the bar.
    await mock.saveWorkspace({
      id: workspace.id,
      name: "tower-infrastructure",
      projectIds: workspace.projectIds,
      homeProjectId: workspace.homeProjectId,
    });
    await mock.renameFeature(workspace.id, "mail-trigger", "poly-freshness-monitor");
    await mock.rename(made.inReview, "Rebuild poly-freshness-checker against the new feed");
    return made;
  });
};

/** Goes to `path` in the app's router, as a link does: no reload, so the mock's world stays. */
const routeTo = (page: Page, path: string) =>
  page.evaluate((to) => {
    history.pushState(history.state, "", to);
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, path);

/** How often the bar's fold changes over `ms`, with nothing resized or changed meanwhile. */
const foldChangesOver = (page: Page, ms: number) =>
  page.getByTestId("shell-titlebar").evaluate(
    (bar, wait) =>
      new Promise<number>((resolve) => {
        let changes = 0;
        const watch = new MutationObserver(() => {
          changes += 1;
        });
        watch.observe(bar, { attributes: true, attributeFilter: ["data-fold"] });
        setTimeout(() => {
          watch.disconnect();
          resolve(changes);
        }, wait);
      }),
    ms,
  );

test("a worker's title bar holds its fold at a width where folding frees the room it measures", async ({
  page,
}) => {
  const made = await start(page, 1600);
  await routeTo(page, `/t/${made.inReview}`);
  const bar = page.getByTestId("shell-titlebar");
  // Wide, everything fits: Take over and its ⓘ are in the bar, unfolded.
  await expect(bar.getByTestId("worker-take-over")).toBeVisible();
  await expect(bar.getByTestId("worker-take-over-info")).toBeVisible();
  await expect(bar).not.toHaveAttribute("data-fold");

  // Narrower, the worker's title is short of room: Take over folds into "…", and stays there.
  await page.setViewportSize({ width: 1200, height: 720 });
  await expect(bar).toHaveAttribute("data-fold", "2");
  expect(await foldChangesOver(page, 1_000)).toBe(0);
  await expect(bar).toHaveAttribute("data-fold", "2");
  await expect(bar.getByTestId("worker-take-over")).toBeHidden();

  // Wide again, it comes back, and holds there too.
  await page.setViewportSize({ width: 1600, height: 720 });
  await expect(bar).not.toHaveAttribute("data-fold");
  expect(await foldChangesOver(page, 500)).toBe(0);
  await expect(bar.getByTestId("worker-take-over")).toBeVisible();
});
