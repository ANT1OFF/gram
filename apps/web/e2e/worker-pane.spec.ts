import { expect, test, type Page } from "@playwright/test";

import { openOrchestrator } from "./thread-row";

// A worker open in the right pane beside its orchestrator, on the realistic morning: the keys go
// into the pane when it opens and back to the worker's row when it closes, a finished worker is
// read only, and a link in the worker's own transcript opens the worker's own tool.

const realistic = async (page: Page) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.orchestration", "realistic");
  });
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  const made = await page.evaluate(async () => {
    const started = await window.gramMock!.startedRealistic();
    if (started === undefined) throw new Error("the mock did not start the realistic scenario");
    return started;
  });
  await openOrchestrator(page, made.orchestratorThreadId);
  await expect(page.locator(`[data-thread-view="${made.orchestratorThreadId}"]`)).toBeVisible();
  return made;
};

const pane = (page: Page) => page.getByTestId("beside-dock");
const row = (page: Page, threadId: string) =>
  page.locator(`[data-testid="workers-panel-row"][data-thread-id="${threadId}"]`);
const focused = (page: Page) =>
  page.evaluate(() => {
    const at = document.activeElement;
    return `${at?.getAttribute("data-testid") ?? at?.tagName}:${at?.getAttribute("data-thread-id") ?? ""}`;
  });

test("opening a worker puts the keys in the pane, so Esc and ↓ work at once, and Back puts them on the worker's row", async ({
  page,
}) => {
  const made = await realistic(page);
  const url = page.url();
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await expect.poll(() => focused(page)).toMatch(/^workers-panel-row:/);

  // ⏎ on a row: the worker opens, its title holding the keys.
  await page.keyboard.press("Enter");
  await expect(pane(page)).toBeVisible();
  await expect.poll(() => focused(page)).toBe("beside-title:");
  const first = await pane(page).getAttribute("data-thread-id");
  // Esc at once goes back, the keys on the row it came from.
  await page.keyboard.press("Escape");
  await expect.poll(() => focused(page)).toBe(`workers-panel-row:${first}`);

  // A click opens it too, with the same keys; ↓ steps to the next worker and Esc goes back to
  // that one's row, current and in view, its group unfolded if it was folded.
  await row(page, made.searchWorker).click();
  await expect.poll(() => focused(page)).toBe("beside-title:");
  await page.keyboard.press("ArrowDown");
  await expect(pane(page)).not.toHaveAttribute("data-thread-id", made.searchWorker);
  const next = (await pane(page).getAttribute("data-thread-id"))!;
  await page.keyboard.press("Escape");
  await expect.poll(() => focused(page)).toBe(`workers-panel-row:${next}`);
  await expect(row(page, next)).toHaveAttribute("aria-current", "true");
  await expect(row(page, next)).toBeInViewport();
  // The orchestrator stayed in the main view throughout.
  expect(page.url()).toBe(url);
});

test("a finished worker is read only, and its PR's files are its Changes", async ({ page }) => {
  await realistic(page);
  await page.keyboard.press("ControlOrMeta+KeyJ");
  const done = page.getByTestId("workers-group-done");
  await done.getByRole("button").first().click();
  await done.getByTestId("workers-panel-row").first().click();
  await expect(pane(page)).toBeVisible();

  // No composer to steer it: a line saying it is read only instead.
  await expect(pane(page).getByTestId("beside-readonly-note")).toBeVisible();
  await expect(pane(page).getByRole("textbox", { name: "Message" })).toHaveCount(0);
  // Nothing runs in it, so no Terminal or Files; each says why.
  for (const tool of ["terminal", "files"]) {
    await expect(pane(page).getByTestId(`beside-tab-${tool}`)).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  }
  // Changes counts and lists what its merged PR changed, not an empty tree on main.
  const changes = pane(page).getByTestId("beside-tab-changes");
  await expect(changes).toHaveText(/Changes\d+/);
  const count = Number((await changes.textContent())!.replace(/\D/g, ""));
  await changes.click();
  await expect(pane(page).getByTestId("finished-files-all").locator("li")).toHaveCount(count);
});

test("View changes in a worker's transcript opens that worker's Changes, beside the chat", async ({
  page,
}) => {
  const made = await realistic(page);
  const url = page.url();
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await row(page, made.searchWorker).click();
  await expect(pane(page).getByTestId("beside-tab-thread")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await pane(page).getByTestId("turn-view-changes").first().click();
  await expect(pane(page).getByTestId("beside-tab-changes")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // The worker is still the one open, and the orchestrator still in the main view.
  await expect(pane(page)).toHaveAttribute("data-thread-id", made.searchWorker);
  expect(page.url()).toBe(url);
});

test("a worker's PR tool opens the PR it names, and its Files its own checkout", async ({
  page,
}) => {
  const made = await realistic(page);
  await page.keyboard.press("ControlOrMeta+KeyJ");
  await row(page, made.searchWorker).click();

  const pr = pane(page).getByTestId("beside-tab-pr");
  await expect(pr).toHaveText(/#142/);
  await pr.click();
  await expect(pane(page).getByText("No PR for this branch")).toHaveCount(0);
  await expect(pane(page).getByText("#142").first()).toBeVisible();

  await pane(page).getByTestId("beside-tab-files").click();
  await expect(pane(page).getByText(/^Not found/)).toHaveCount(0);
  await expect(pane(page).getByText("package.json")).toBeVisible();
});
